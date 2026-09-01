import { cached } from './cache.mjs'
import { getBirdeyeTokenOverview } from './birdeye.mjs'
import { getConfig } from './config.mjs'
import { HEARTBEAT_DEPLOYED_AT } from './generated-build-info.mjs'
import { getPythSolUsdPrice } from './price.mjs'
import { connectionFor, getPositiveHolderCount } from './solana.mjs'

const EMPTY = {
  status: null, rawHolderCount: null, holderCount: null, deploymentTimestamp: HEARTBEAT_DEPLOYED_AT, ageMs: null,
  lifetimeGlobalFeesSol: null, todayGlobalFeesSol: null, currentSolUsdPrice: null,
  creatorAddress: null, creatorShareBps: null, claimedCreatorFeesSol: null, unclaimedCreatorFeesSol: null,
  lifetimeCreatorFeesSol: null, todayCreatorFeesSol: null,
  balanceUsd: null, earnedTodayUsd: null, feeSource: null, globalFeeSource: null,
  holderSource: null, birthSource: 'build', ageSource: 'build', todayFeesSource: null,
}

function base(mint) {
  return {
    mint, ...EMPTY, ca: mint,
    ageMs: Math.max(0, Date.now() - HEARTBEAT_DEPLOYED_AT),
    fetchedAt: Date.now(),
  }
}
// This is deliberately RPC-free. The status poller uses it before its first
// successful read so visitors can receive a stable LOADING snapshot without
// causing a live blockchain request of their own.
export function getHeartbeatStatusPlaceholder() {
  return base(getConfig().mint)
}
function deploymentAge() { return Math.max(0, Date.now() - HEARTBEAT_DEPLOYED_AT) }
function usd(feesSol, solUsdPrice) { return feesSol === null || solUsdPrice === null ? null : feesSol * solUsdPrice }

function warn(part, error) {
  if (process.env.NODE_ENV !== 'production') console.warn(`[heartbeat-status:${part}]`, error.message)
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

export async function getHeartbeatStatusPart(part = 'all') {
  const config = getConfig()
  const response = base(config.mint)
  if (!config.mint || !config.rpcUrl) return response

  // Birdeye remains the fast primary source for holders/global fees.
  const connection = connectionFor(config.heliusRpcUrl ?? config.rpcUrl)
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
    core: async () => ({}),
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
  response.ageMs = deploymentAge()
  response.fetchedAt = Date.now()
  return response
}
