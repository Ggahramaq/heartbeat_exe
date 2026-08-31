import { cached } from './cache.mjs'
import { getBirdeyeBirthTimestamp, getBirdeyeTokenOverview } from './birdeye.mjs'
import { getConfig } from './config.mjs'
import { readMintIndex, writeMintIndex } from './index-store.mjs'
import { getPythSolUsdPrice } from './price.mjs'
import { connectionFor, findMintCreationTimestamp, findPumpMintCreationTimestamp, getPositiveHolderCount } from './solana.mjs'

const EMPTY = {
  status: null, rawHolderCount: null, holderCount: null, creationTimestamp: null, ageMs: null,
  lifetimeGlobalFeesSol: null, todayGlobalFeesSol: null, currentSolUsdPrice: null,
  creatorAddress: null, creatorShareBps: null, claimedCreatorFeesSol: null, unclaimedCreatorFeesSol: null,
  lifetimeCreatorFeesSol: null, todayCreatorFeesSol: null,
  balanceUsd: null, earnedTodayUsd: null, feeSource: null, globalFeeSource: null,
  holderSource: null, birthSource: null, todayFeesSource: null,
}
const verifyingBirths = new Set()

function base(mint) { return { mint, ...EMPTY, ca: mint, fetchedAt: Date.now() } }
// This is deliberately RPC-free. The status poller uses it before its first
// successful read so visitors can receive a stable LOADING snapshot without
// causing a live blockchain request of their own.
export function getSurviveStatusPlaceholder() {
  return base(getConfig().mint)
}
function ageFor(timestamp) { return timestamp === null ? null : Math.max(0, Date.now() - timestamp) }
function usd(feesSol, solUsdPrice) { return feesSol === null || solUsdPrice === null ? null : feesSol * solUsdPrice }

function warn(part, error) {
  if (process.env.NODE_ENV !== 'production') console.warn(`[survive-status:${part}]`, error.message)
}

async function creationTimestampFor(connection, mint) {
  const stored = await readMintIndex(mint)
  if (stored?.creationTimestamp) return stored.creationTimestamp
  const pumpCreationTimestamp = await findPumpMintCreationTimestamp(connection, mint)
  const creationTimestamp = pumpCreationTimestamp ?? await findMintCreationTimestamp(connection, mint)
  await writeMintIndex(mint, { ...stored, creationTimestamp })
  if (process.env.NODE_ENV !== 'production' && stored?.birdeyeBirth?.timestampMs) {
    const differenceSeconds = Math.round((creationTimestamp - stored.birdeyeBirth.timestampMs) / 1_000)
    console.info(`[age:verify] mint=${mint} birdeye=${new Date(stored.birdeyeBirth.timestampMs).toISOString()} onchain=${new Date(creationTimestamp).toISOString()} difference=${differenceSeconds}s`)
  }
  return creationTimestamp
}

function verifyBirthInBackground(connection, mint) {
  if (verifyingBirths.has(mint)) return
  verifyingBirths.add(mint)
  void creationTimestampFor(connection, mint)
    .catch((error) => { if (process.env.NODE_ENV !== 'production') console.warn(`[age:verify] mint=${mint} unavailable: ${error.message}`) })
    .finally(() => verifyingBirths.delete(mint))
}

function normalizeHolders(rawHolderCount, holderSource) {
  const raw = Number.isFinite(rawHolderCount) && rawHolderCount >= 0
    ? Math.trunc(rawHolderCount)
    : null
  const holderCount = raw === null ? null : Math.max(raw - 1, 0)
  if (process.env.NODE_ENV !== 'production' && raw !== null) {
    console.info(`[holders] raw provider holders: ${raw}; excluded liquidity account: 1; displayed holders: ${holderCount}; source=${holderSource}`)
  }
  return { rawHolderCount: raw, holderCount, holderSource }
}

async function resolveBirth(connection, mint) {
  const stored = await readMintIndex(mint)
  if (stored?.creationTimestamp) return { creationTimestamp: stored.creationTimestamp, birthSource: 'solana-verified' }

  // Birdeye's exact/listing endpoints are not available on every plan. Race
  // them against the Pump-specific curve history instead of spending three
  // seconds on Birdeye and only then beginning the RPC fallback.
  const birdeyePromise = getBirdeyeBirthTimestamp(mint)
  const pumpPromise = findPumpMintCreationTimestamp(connection, mint)
  const validBirdeye = birdeyePromise.then((result) => {
    if (!result?.timestampMs) throw new Error('Birdeye birth timestamp unavailable')
    return { creationTimestamp: result.timestampMs, birthSource: result.source }
  })
  const validPump = pumpPromise.then((creationTimestamp) => {
    if (!creationTimestamp) throw new Error('Pump creation timestamp unavailable')
    return { creationTimestamp, birthSource: 'solana-pump-curve' }
  })

  try {
    const winner = await Promise.any([validBirdeye, validPump])
    if (winner.birthSource === 'solana-pump-curve') {
      await writeMintIndex(mint, { ...stored, creationTimestamp: winner.creationTimestamp })
    } else {
      // The already-running Pump lookup becomes background verification. Do
      // not launch a duplicate history scan after Birdeye wins the race.
      void pumpPromise.then(async (onChainTimestamp) => {
        if (!onChainTimestamp) return
        const latest = (await readMintIndex(mint)) ?? {}
        await writeMintIndex(mint, { ...latest, creationTimestamp: onChainTimestamp })
        if (process.env.NODE_ENV !== 'production') {
          const differenceSeconds = Math.round((onChainTimestamp - winner.creationTimestamp) / 1_000)
          console.info(`[age:verify] mint=${mint} birdeye=${new Date(winner.creationTimestamp).toISOString()} onchain=${new Date(onChainTimestamp).toISOString()} difference=${differenceSeconds}s`)
        }
      }).catch((error) => {
        if (process.env.NODE_ENV !== 'production') console.warn(`[age:verify] mint=${mint} unavailable: ${error.message}`)
      })
    }
    if (process.env.NODE_ENV !== 'production') console.info(`[age] source=${winner.birthSource} timestamp=${winner.creationTimestamp} ageMs=${Math.max(0, Date.now() - winner.creationTimestamp)} mint=${mint}`)
    return winner
  } catch {
    // Neither fast source produced a value. Retain the complete mint-history
    // walk as the final compatibility fallback for non-Pump/archival cases.
    const creationTimestamp = await findMintCreationTimestamp(connection, mint)
    await writeMintIndex(mint, { ...stored, creationTimestamp })
    if (process.env.NODE_ENV !== 'production') console.info(`[age] source=solana-mint-history timestamp=${creationTimestamp} ageMs=${Math.max(0, Date.now() - creationTimestamp)} mint=${mint}`)
    return { creationTimestamp, birthSource: 'solana-mint-history' }
  }
}

async function resolveHolders(connection, mint, heliusRpcUrl) {
  // Restore the previous fast provider path. The direct RPC scan remains a
  // fallback/verification mechanism, but it is no longer the primary source.
  const overview = await getBirdeyeTokenOverview(mint)
  if (overview?.rawHolderCount !== null && overview?.rawHolderCount !== undefined) {
    const normalized = normalizeHolders(overview.rawHolderCount, 'birdeye-token-overview')
    if (process.env.NODE_ENV !== 'production') {
      console.info(`[holders] source=birdeye-token-overview resolved=${overview.resolvedMs}ms displayed=${normalized.holderCount}`)
    }
    return normalized
  }

  const result = await getPositiveHolderCount(connection, mint, heliusRpcUrl)
  const normalized = normalizeHolders(result.rawHolderCount, result.source)
  if (process.env.NODE_ENV !== 'production') {
    console.info(
      `[helius:holders] accounts=${result.accountCount} pages=${result.pages} uniquePositiveOwners=${result.rawHolderCount} `
      + `LP adjustment=-1 displayed=${normalized.holderCount} resolved=${result.resolvedMs}ms source=${result.source}`,
    )
  }
  return normalized
}

export async function getSurviveStatusPart(part = 'all') {
  const config = getConfig()
  const response = base(config.mint)
  if (!config.mint || !config.rpcUrl) return response

  // Birdeye remains the fast primary source for holders/global fees. When it
  // throttles, all on-chain fallbacks (birth timestamp, holders, and Pyth
  // price) use Helius instead of the exhausted legacy general RPC.
  const connection = connectionFor(config.heliusRpcUrl ?? config.rpcUrl)
  // A stored birth timestamp is immutable; this short cache only lets a
  // background chain verification replace a fast Birdeye timestamp promptly.
  const fetchCreation = () => cached(`creation:${config.mint}`, 15_000, () => resolveBirth(connection, config.mint))
  const fetchHolders = () => cached(`holders:${config.mint}`, 14_000, () => resolveHolders(connection, config.mint, config.heliusRpcUrl))
  // BALANCE has one independent fast path: cached Birdeye Overview's
  // global_fees_paid. It neither waits for, nor invokes, creator-fee history.
  const fetchFees = () => cached(`birdeye-overview-fees:${config.mint}`, 9_000, async () => {
    const startedAt = performance.now()
    const overview = await getBirdeyeTokenOverview(config.mint)
    if (overview?.globalFeesLamports === null || overview?.globalFeesLamports === undefined) {
      throw new Error('Birdeye global_fees_paid is unavailable')
    }
    const lifetimeGlobalFeesSol = Number(BigInt(overview.globalFeesLamports)) / 1_000_000_000
    const resolvedMs = Math.round(performance.now() - startedAt)
    if (process.env.NODE_ENV !== 'production') {
      console.info(`[balance-fast] mint=${config.mint} globalFeesPaid=${lifetimeGlobalFeesSol} SOL overviewSource=birdeye overviewMs=${overview.resolvedMs} resolved=${resolvedMs}ms`)
    }
    return {
      lifetimeGlobalFeesSol,
      todayGlobalFeesSol: lifetimeGlobalFeesSol,
      feeSource: 'birdeye-token-overview',
      globalFeeSource: 'birdeye-token-overview',
      overviewResolvedMs: overview.resolvedMs,
    }
  })
  const fetchSolPrice = () => cached('pyth-sol-usd', 9_000, () => getPythSolUsdPrice(connection))

  const tasks = {
    core: async () => {
      const birth = await fetchCreation()
      return { ...birth, ageMs: ageFor(birth.creationTimestamp) }
    },
    holders: async () => {
      const holders = await fetchHolders()
      return {
        ...holders,
        status: holders.holderCount === null
          ? null
          : holders.holderCount === 0 ? 'DEAD' : 'ALIVE',
      }
    },
    fees: async () => {
      if (process.env.NODE_ENV !== 'production') console.info(`[balance-fast] starting resolution mint=${config.mint}`)
      const fees = await fetchFees()
      return fees
    },
    price: async () => {
      const startedAt = performance.now()
      const currentSolUsdPrice = await fetchSolPrice()
      return { currentSolUsdPrice, priceResolvedMs: Math.round(performance.now() - startedAt) }
    },
  }

  if (part in tasks) {
    try { return { ...response, ...(await tasks[part]()), fetchedAt: Date.now() } }
    // `_pollError` is consumed by the server-owned poller only. It is never
    // sent through the public snapshot route, so provider details remain
    // private while the poller can back off instead of retrying a bad scan.
    catch (error) { warn(part, error); return { ...response, _pollError: error.message } }
  }

  const settled = await Promise.allSettled(Object.entries(tasks).map(async ([name, task]) => [name, await task()]))
  for (const result of settled) {
    if (result.status === 'fulfilled') Object.assign(response, result.value[1])
    else warn('all', result.reason)
  }
  response.balanceUsd = usd(response.lifetimeGlobalFeesSol, response.currentSolUsdPrice)
  // Product semantics: EARNED TODAY always mirrors BALANCE, with no extra
  // date calculation or history scan.
  response.todayGlobalFeesSol = response.lifetimeGlobalFeesSol
  response.todayFeesSource = response.lifetimeGlobalFeesSol === null ? null : 'balance-equals-earned-today'
  response.earnedTodayUsd = response.balanceUsd
  response.ageMs = ageFor(response.creationTimestamp)
  response.fetchedAt = Date.now()
  return response
}
