import { PublicKey } from '@solana/web3.js'
import { getOrCreateBirdeyeFeeBootstrap } from './birdeye.mjs'
import { readMintIndex, writeMintIndex } from './index-store.mjs'
import { canonicalPumpSwapPool, getHeliusTransactionsForAddress, getPumpBondingCurve, initialIndexBatchRpc, rpcWithRetry, throttledRpc } from './solana.mjs'
import { easternMidnightUtcMs } from './time.mjs'
import { globalFeesFromPumpEvents, lamportsToSol, decodePumpTradeEvents } from './pump-events.mjs'

const PAGE_SIZE = 1_000
const INDEX_KIND = 'helius-global-trading-fees-v3'
const LEGACY_HELIUS_INDEX_KIND = 'global-trading-fees-v2'
const runningMints = new Set()
const retryAfterByMint = new Map()
const fastHistorySupportByRpcUrl = new Map()
const HARD_QUOTA_COOLDOWN_MS = 60 * 60_000
const INITIAL_TRANSACTION_BATCH_SIZE = Math.min(
  10,
  Math.max(1, Number.parseInt(process.env.SOLANA_INITIAL_INDEX_BATCH_SIZE ?? '10', 10) || 10),
)

function startPerf() {
  return { startedAt: performance.now(), signatures: 0, transactionCalls: 0, decodingMs: 0, rpcCalls: 0, rpcQueueWaitMs: 0, rpcRequestMs: 0, curveLookupMs: 0, poolDerivationMs: 0 }
}

function logPerf(mint, perf, phase) {
  if (process.env.NODE_ENV === 'production') return
  const totalMs = Math.round(performance.now() - perf.startedAt)
  console.info(
    `[perf] fees mint=${mint} phase=${phase} curve=${Math.round(perf.curveLookupMs)}ms `
    + `pool=${Math.round(perf.poolDerivationMs)}ms signatures=${perf.signatures} `
    + `getTransaction=${perf.transactionCalls} rpcCalls=${perf.rpcCalls} `
    + `rpcQueue=${Math.round(perf.rpcQueueWaitMs)}ms rpcRequest=${Math.round(perf.rpcRequestMs)}ms `
    + `decode=${Math.round(perf.decodingMs)}ms total=${totalMs}ms`,
  )
}

// Anchor events are emitted as `Program data: <base64>` in the transaction log.
// These offsets follow the public Pump / PumpSwap IDLs. The result is the one
// canonical global trading fee for a trade - it never reads transaction.meta.fee
// (network gas), volume, liquidity, or a wallet/vault balance.
function globalFeesFromTransaction(transaction, mint, pool) {
  const events = decodePumpTradeEvents({
    logMessages: transaction?.meta?.logMessages,
    mint,
    pool,
    fallbackTimestampMs: transaction?.blockTime ? transaction.blockTime * 1_000 : Date.now(),
  })
  return globalFeesFromPumpEvents(events)
}

function toSol(lamports) {
  return lamportsToSol(lamports)
}

function emptyIndex() {
  return {
    kind: INDEX_KIND, indexSchemaVersion: 1, initializationSource: 'helius-targeted-history', phase: 'indexing', before: null,
    lifetimeGlobalFeesLamports: '0', todayGlobalFeesLamports: '0', transactionsScanned: 0,
    todayStartUtcMs: easternMidnightUtcMs(), newestSignature: null, newestSlot: null,
    lastProcessedSignature: null, lastProcessedSlot: null, updatedAt: Date.now(),
  }
}

function publicStats(index) {
  if (
    !index
    || ![INDEX_KIND, LEGACY_HELIUS_INDEX_KIND].includes(index.kind)
    || index.phase !== 'ready'
    || (index.kind === INDEX_KIND && index.indexSchemaVersion !== 1)
  ) {
    return { lifetimeGlobalFeesSol: null, todayGlobalFeesSol: null, feeSource: null }
  }
  return {
    lifetimeGlobalFeesSol: toSol(BigInt(index.lifetimeGlobalFeesLamports)),
    todayGlobalFeesSol: toSol(BigInt(index.todayGlobalFeesLamports)),
    feeSource: 'helius-fee-index',
  }
}

async function save(mint, stored, feeIndex) {
  await writeMintIndex(mint, { ...stored, feeIndex })
}

function logReadyIndex(mint, feeIndex) {
  if (process.env.NODE_ENV === 'production') return
  const stats = publicStats(feeIndex)
  console.info(
    `[global-fees] mint=${mint} scanned=${feeIndex.transactionsScanned ?? 0} `
    + `lifetime=${stats.lifetimeGlobalFeesSol ?? 'LOADING'} SOL `
    + `today=${stats.todayGlobalFeesSol ?? 'LOADING'} SOL easternStart=${new Date(feeIndex.todayStartUtcMs).toISOString()}`,
  )
}

function isFastHistoryUnavailable(error) {
  return /method not found|not supported|forbidden|403|plan|unavailable/i.test(error?.message ?? '')
}

function historyTargets(curve, pool) {
  // Before graduation, every relevant trade touches the curve. After
  // graduation we retain its history and add the canonical PumpSwap pool.
  return curve.complete ? [curve.address, pool] : [curve.address]
}

function updateTotalsFromTransactions({ transactions, mint, pool, total, today, easternStart, perf }) {
  let newestSignature = null
  let newestSlot = null
  let scanned = 0
  for (const transaction of transactions) {
    if (!transaction?.meta || !transaction?.transaction || !transaction?.blockTime) continue
    scanned += 1
    const decodingStartedAt = performance.now()
    const fee = globalFeesFromTransaction(transaction, mint, pool)
    perf.decodingMs += performance.now() - decodingStartedAt
    total += fee
    if (transaction.blockTime * 1_000 >= easternStart) today += fee
    newestSignature = transaction.signature ?? newestSignature
    newestSlot = Number.isFinite(transaction.slot) ? transaction.slot : newestSlot
  }
  return { total, today, scanned, newestSignature, newestSlot }
}

function markerFor(transaction) {
  const signature = transaction?.signature
  const slot = Number(transaction?.slot)
  return typeof signature === 'string' && Number.isFinite(slot) ? { signature, slot } : null
}

// Helius's enhanced historical RPC returns up to 100 full transactions per
// request. It avoids the former signature-list + N getTransaction cold path.
// A persisted cursor lets an old/high-volume mint finish in background chunks
// while new coins normally complete in just a few requests.
async function indexInitialHeliusHistory(rpcUrl, mintAddress, stored, feeIndex, curve, pool, perf) {
  if (fastHistorySupportByRpcUrl.get(rpcUrl) === false) return null
  const mint = new PublicKey(mintAddress)
  const state = feeIndex.fastHistory ?? { targetIndex: 0, paginationToken: null }
  const targets = historyTargets(curve, pool)
  let targetMarkers = { ...(feeIndex.targetMarkers ?? {}) }
  let total = BigInt(feeIndex.lifetimeGlobalFeesLamports)
  let today = BigInt(feeIndex.todayGlobalFeesLamports)
  let scanned = feeIndex.transactionsScanned ?? 0
  const easternStart = easternMidnightUtcMs()

  try {
    for (let page = 0; page < 4 && state.targetIndex < targets.length; page += 1) {
      const target = targets[state.targetIndex].toBase58()
      const result = await getHeliusTransactionsForAddress(rpcUrl, target, {
        sortOrder: 'asc',
        ...(state.paginationToken ? { paginationToken: state.paginationToken } : {}),
      })
      fastHistorySupportByRpcUrl.set(rpcUrl, true)
      const transactions = Array.isArray(result?.data) ? result.data : []
      perf.signatures += transactions.length
      perf.transactionCalls += transactions.length
      const updated = updateTotalsFromTransactions({ transactions, mint, pool, total, today, easternStart, perf })
      total = updated.total
      today = updated.today
      scanned += updated.scanned
      if (updated.newestSignature) {
        feeIndex.newestSignature = updated.newestSignature
        feeIndex.newestSlot = updated.newestSlot ?? feeIndex.newestSlot
        targetMarkers = {
          ...targetMarkers,
          [target]: {
            signature: updated.newestSignature,
            slot: updated.newestSlot ?? targetMarkers[target]?.slot ?? 0,
          },
        }
      }
      const nextToken = result?.paginationToken ?? null
      if (nextToken) {
        state.paginationToken = nextToken
      } else {
        state.targetIndex += 1
        state.paginationToken = null
      }
      feeIndex = {
        ...feeIndex,
        kind: INDEX_KIND,
        phase: state.targetIndex >= targets.length ? 'ready' : 'indexing',
        lifetimeGlobalFeesLamports: total.toString(),
        todayGlobalFeesLamports: today.toString(),
        todayStartUtcMs: easternStart,
        transactionsScanned: scanned,
        fastHistory: state.targetIndex >= targets.length ? null : state,
        targetMarkers,
        lastProcessedSignature: feeIndex.newestSignature,
        lastProcessedSlot: feeIndex.newestSlot,
        updatedAt: Date.now(),
      }
      await save(mintAddress, stored, feeIndex)
    }
    if (feeIndex.phase === 'ready') {
      logReadyIndex(mintAddress, feeIndex)
    }
    return feeIndex.phase === 'ready'
  } catch (error) {
    if (isFastHistoryUnavailable(error)) {
      fastHistorySupportByRpcUrl.set(rpcUrl, false)
      if (process.env.NODE_ENV !== 'production') console.warn(`[helius:fees] getTransactionsForAddress unavailable; using standard Helius RPC: ${error.message}`)
      return null
    }
    throw error
  }
}

// Once an index is complete, use the same targeted Helius history route for
// restart catch-up.  It reads only transactions newer than the durable marker
// for each Pump venue; it never replays the mint's whole transaction history.
async function indexNewHeliusHistory(rpcUrl, mintAddress, stored, feeIndex, curve, pool, perf) {
  if (fastHistorySupportByRpcUrl.get(rpcUrl) === false) return null
  const targets = historyTargets(curve, pool).map((target) => target.toBase58())
  const markers = feeIndex.targetMarkers
  if (!markers || !targets.every((target) => markers[target]?.signature)) return null

  const mint = new PublicKey(mintAddress)
  const easternStart = easternMidnightUtcMs()
  let total = BigInt(feeIndex.lifetimeGlobalFeesLamports)
  let today = feeIndex.todayStartUtcMs === easternStart
    ? BigInt(feeIndex.todayGlobalFeesLamports)
    : 0n
  let scanned = feeIndex.transactionsScanned ?? 0
  const nextMarkers = { ...markers }
  const seenSignatures = new Set()

  try {
    for (const target of targets) {
      const marker = markers[target]
      let paginationToken = null
      let newestMarker = null
      let reachedMarker = false
      for (let page = 0; page < 4 && !reachedMarker; page += 1) {
        const result = await getHeliusTransactionsForAddress(rpcUrl, target, {
          sortOrder: 'desc',
          ...(paginationToken ? { paginationToken } : {}),
        })
        fastHistorySupportByRpcUrl.set(rpcUrl, true)
        const transactions = Array.isArray(result?.data) ? result.data : []
        perf.signatures += transactions.length
        perf.transactionCalls += transactions.length
        for (const transaction of transactions) {
          const currentMarker = markerFor(transaction)
          if (!currentMarker) continue
          if (!newestMarker) newestMarker = currentMarker
          // A durable per-venue signature is the exact stop point.  The slot
          // guard also ends safely if a provider prunes that old signature.
          if (
            currentMarker.signature === marker.signature
            || currentMarker.slot < marker.slot
            // Live WSS writes advance this global checkpoint immediately.
            // Stop at it so the ten-second verification pass never adds a
            // transaction that the shared live stream already accounted for.
            || currentMarker.slot <= (feeIndex.lastProcessedSlot ?? marker.slot)
          ) {
            reachedMarker = true
            break
          }
          if (!seenSignatures.has(currentMarker.signature)) {
            seenSignatures.add(currentMarker.signature)
            const updated = updateTotalsFromTransactions({
              transactions: [transaction], mint, pool, total, today, easternStart, perf,
            })
            total = updated.total
            today = updated.today
            scanned += updated.scanned
          }
        }
        if (!reachedMarker) {
          paginationToken = result?.paginationToken ?? null
          if (!paginationToken) throw new Error('Fee index marker is no longer available from Helius history')
        }
      }
      if (!reachedMarker) return false
      if (newestMarker) nextMarkers[target] = newestMarker
    }

    const next = {
      ...feeIndex,
      kind: INDEX_KIND,
      lifetimeGlobalFeesLamports: total.toString(),
      todayGlobalFeesLamports: today.toString(),
      todayStartUtcMs: easternStart,
      transactionsScanned: scanned,
      targetMarkers: nextMarkers,
      newestSignature: Object.values(nextMarkers).at(-1)?.signature ?? feeIndex.newestSignature,
      newestSlot: Math.max(...Object.values(nextMarkers).map((value) => value.slot ?? 0), feeIndex.newestSlot ?? 0),
      lastProcessedSignature: Object.values(nextMarkers).at(-1)?.signature ?? feeIndex.lastProcessedSignature,
      lastProcessedSlot: Math.max(...Object.values(nextMarkers).map((value) => value.slot ?? 0), feeIndex.lastProcessedSlot ?? 0),
      updatedAt: Date.now(),
    }
    await save(mintAddress, stored, next)
    if (scanned !== (feeIndex.transactionsScanned ?? 0)) logReadyIndex(mintAddress, next)
    return true
  } catch (error) {
    if (isFastHistoryUnavailable(error)) {
      fastHistorySupportByRpcUrl.set(rpcUrl, false)
      return null
    }
    throw error
  }
}

async function indexInitialHistory(connection, mintAddress, historyAddress, stored, feeIndex, pool, perf) {
  const mint = new PublicKey(mintAddress)
  const historyAccount = new PublicKey(historyAddress)
  let before = feeIndex.before ?? undefined
  let total = BigInt(feeIndex.lifetimeGlobalFeesLamports)
  let today = BigInt(feeIndex.todayGlobalFeesLamports)
  let transactionsScanned = feeIndex.transactionsScanned ?? 0
  const easternStart = easternMidnightUtcMs()
  for (let page = 0; page < 4; page += 1) {
    const signatures = await rpcWithRetry(() => connection.getSignaturesForAddress(historyAccount, { before, limit: PAGE_SIZE }), 'Global-fee signature history', perf)
    perf.signatures += signatures.length
    if (!signatures.length) {
      feeIndex = { ...feeIndex, phase: 'ready', before: null, lifetimeGlobalFeesLamports: total.toString(), todayGlobalFeesLamports: today.toString(), transactionsScanned, todayStartUtcMs: easternStart, updatedAt: Date.now() }
      await save(mintAddress, stored, feeIndex)
      logReadyIndex(mintAddress, feeIndex)
      return true
    }
    if (!feeIndex.newestSignature) {
      feeIndex.newestSignature = signatures[0].signature
      feeIndex.newestSlot = signatures[0].slot
      await save(mintAddress, stored, feeIndex)
    }
    // web3.js turns getTransactions into a JSON-RPC batch. The shared gate
    // limits batches, not individual historical transactions, eliminating the
    // old N * 500ms cold-start while retaining bounded provider pressure.
    for (let start = 0; start < signatures.length; start += INITIAL_TRANSACTION_BATCH_SIZE) {
      const entries = signatures.slice(start, start + INITIAL_TRANSACTION_BATCH_SIZE)
      const fetchable = entries.filter((entry) => !entry.err && entry.blockTime)
      perf.transactionCalls += fetchable.length
      const transactions = fetchable.length
        ? await initialIndexBatchRpc(
          () => connection.getTransactions(
            fetchable.map((entry) => entry.signature),
            { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
          ),
          fetchable.length,
          'Global-fee transaction batch',
          perf,
        )
        : []
      const bySignature = new Map(fetchable.map((entry, index) => [entry.signature, transactions[index]]))
      for (const entry of entries) {
        if (entry.err || !entry.blockTime) continue
        transactionsScanned += 1
        const decodingStartedAt = performance.now()
        const globalFee = globalFeesFromTransaction(bySignature.get(entry.signature), mint, pool)
        perf.decodingMs += performance.now() - decodingStartedAt
        total += globalFee
        if (entry.blockTime * 1000 >= easternStart) today += globalFee
      }
      const checkpoint = entries.at(-1)
      // Checkpoint each completed batch. A retry cannot publish a partial
      // lifetime total, and a restart resumes after the last durable chunk.
      feeIndex = {
        ...feeIndex, before: checkpoint.signature, lifetimeGlobalFeesLamports: total.toString(),
        todayGlobalFeesLamports: today.toString(), transactionsScanned, todayStartUtcMs: easternStart,
        lastProcessedSignature: checkpoint.signature, lastProcessedSlot: checkpoint.slot, updatedAt: Date.now(),
      }
      await save(mintAddress, stored, feeIndex)
    }
    before = signatures.at(-1).signature
    feeIndex = { ...feeIndex, before, lifetimeGlobalFeesLamports: total.toString(), todayGlobalFeesLamports: today.toString(), transactionsScanned, todayStartUtcMs: easternStart, updatedAt: Date.now() }
    await save(mintAddress, stored, feeIndex)
    if (signatures.length < PAGE_SIZE) {
      feeIndex = { ...feeIndex, phase: 'ready', before: null, updatedAt: Date.now() }
      await save(mintAddress, stored, feeIndex)
      logReadyIndex(mintAddress, feeIndex)
      return true
    }
  }
  return false
}

async function indexNewHistory(connection, mintAddress, historyAddress, stored, feeIndex, pool, perf) {
  const mint = new PublicKey(mintAddress)
  const historyAccount = new PublicKey(historyAddress)
  const easternStart = easternMidnightUtcMs()
  const incremental = feeIndex.incremental
  let total = BigInt(incremental?.lifetimeGlobalFeesLamports ?? feeIndex.lifetimeGlobalFeesLamports)
  let today = incremental?.todayStartUtcMs === easternStart
    ? BigInt(incremental.todayGlobalFeesLamports)
    : feeIndex.todayStartUtcMs === easternStart ? BigInt(feeIndex.todayGlobalFeesLamports) : 0n
  let before = incremental?.before ?? undefined
  const targetSignature = incremental?.targetSignature ?? feeIndex.newestSignature
  let headSignature = incremental?.headSignature ?? null
  for (let page = 0; page < 4; page += 1) {
    const signatures = await rpcWithRetry(() => connection.getSignaturesForAddress(historyAccount, { before, limit: PAGE_SIZE }), 'Incremental global-fee history', perf)
    perf.signatures += signatures.length
    if (!signatures.length) throw new Error('Fee index marker is no longer available from this RPC')
    if (!headSignature) headSignature = signatures[0].signature
    let reachedMarker = false
    for (const entry of signatures) {
      if (entry.signature === targetSignature) {
        reachedMarker = true
        break
      }
      if (entry.err || !entry.blockTime) continue
      perf.transactionCalls += 1
      const transaction = await throttledRpc(() => connection.getTransaction(entry.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }), 'Incremental global-fee transaction', perf)
      const decodingStartedAt = performance.now()
      const globalFee = globalFeesFromTransaction(transaction, mint, pool)
      perf.decodingMs += performance.now() - decodingStartedAt
      total += globalFee
      if (entry.blockTime * 1000 >= easternStart) today += globalFee
    }
    if (reachedMarker) {
      feeIndex = {
        ...feeIndex, lifetimeGlobalFeesLamports: total.toString(), todayGlobalFeesLamports: today.toString(), todayStartUtcMs: easternStart,
        newestSignature: headSignature, updatedAt: Date.now(), incremental: null,
      }
      await save(mintAddress, stored, feeIndex)
      logReadyIndex(mintAddress, feeIndex)
      return true
    }
    if (signatures.length < PAGE_SIZE) throw new Error('Fee index marker is no longer available from this RPC')
    before = signatures.at(-1).signature
  }
  // More than four pages arrived between syncs. Persist a cursor and let the
  // background worker continue from it; this prevents either rescanning or
  // silently skipping a burst of on-chain activity.
  feeIndex = {
    ...feeIndex, updatedAt: Date.now(),
    incremental: {
      before, targetSignature, headSignature, lifetimeGlobalFeesLamports: total.toString(),
      todayGlobalFeesLamports: today.toString(), todayStartUtcMs: easternStart,
    },
  }
  await save(mintAddress, stored, feeIndex)
  return false
}

export async function getIndexedPumpGlobalFeeStats(connection, mintAddress, heliusRpcUrl) {
  const stored = (await readMintIndex(mintAddress)) ?? {}
  const stats = publicStats(stored.feeIndex)
  // Restore the former fast balance path: Birdeye supplies the completed
  // all-time snapshot immediately, while the native index remains a
  // background verifier/catch-up process rather than blocking the UI.
  const birdeyeStats = await getOrCreateBirdeyeFeeBootstrap(mintAddress)
  if (birdeyeStats?.lifetimeGlobalFeesSol !== null && birdeyeStats?.lifetimeGlobalFeesSol !== undefined) {
    return birdeyeStats
  }
  if (
    !runningMints.has(mintAddress)
    && (retryAfterByMint.get(mintAddress) ?? 0) <= Date.now()
  ) {
    runningMints.add(mintAddress)
    void (async () => {
      let continueWork = false
      let retryDelayMs = 0
      const perf = startPerf()
      try {
        const curveStartedAt = performance.now()
        const curve = await getPumpBondingCurve(connection, mintAddress)
        perf.curveLookupMs = performance.now() - curveStartedAt
        if (!curve) throw new Error('Configured mint has no official Pump bonding curve')
        const poolStartedAt = performance.now()
        const pool = canonicalPumpSwapPool(mintAddress)
        perf.poolDerivationMs = performance.now() - poolStartedAt
        const latest = (await readMintIndex(mintAddress)) ?? {}
        // The previous creator-fee cache deliberately cannot be reused here:
        // global trading fees have different semantics and component fields.
        let feeIndex = [INDEX_KIND, LEGACY_HELIUS_INDEX_KIND].includes(latest.feeIndex?.kind)
          ? { ...latest.feeIndex, kind: INDEX_KIND }
          : emptyIndex()
        // A pre-schema partial index could have been written by an older
        // local process before the single-writer Helius migration was in
        // place. It was never publishable (`phase: indexing`), so restart it
        // once rather than risking a duplicated lifetime total. Complete
        // persisted indexes remain instant across ordinary server restarts.
        if (feeIndex.kind === INDEX_KIND && feeIndex.indexSchemaVersion !== 1) {
          feeIndex = emptyIndex()
          await save(mintAddress, latest, feeIndex)
        }
        if (feeIndex.phase === 'ready') {
          const caughtUp = await indexNewHeliusHistory(
            heliusRpcUrl,
            mintAddress,
            latest,
            feeIndex,
            curve,
            pool,
            perf,
          )
          if (caughtUp === true) return
          if (caughtUp === false) {
            continueWork = true
            retryDelayMs = 0
            return
          }
        }

        const fastComplete = feeIndex.phase === 'ready' ? null : await indexInitialHeliusHistory(
          heliusRpcUrl,
          mintAddress,
          latest,
          feeIndex,
          curve,
          pool,
          perf,
        )
        if (fastComplete === true) return
        // A large history consumed its bounded fast-history chunk. The cursor
        // is persisted, so continue in the background rather than starting a
        // second standard-RPC scan from zero.
        if (fastComplete === false) {
          continueWork = true
          retryDelayMs = 0
          return
        }
        // This compatibility path is only used when the Helius enhanced
        // history method is unavailable. Normal operation always uses the
        // targeted curve/pool history above.
        const historyAddress = curve.complete ? mintAddress : curve.address.toBase58()
        if (feeIndex.phase === 'ready') continueWork = !(await indexNewHistory(connection, mintAddress, historyAddress, latest, feeIndex, pool, perf))
        else continueWork = !(await indexInitialHistory(connection, mintAddress, historyAddress, latest, feeIndex, pool, perf))
      } catch (error) {
        if (process.env.NODE_ENV !== 'production') console.warn('[heartbeat-global-fee-index]', error.message)
        if (/daily request limit|monthly request limit|quota (?:is )?exceeded|usage limit exceeded/i.test(error?.message ?? '')) {
          retryAfterByMint.set(mintAddress, Date.now() + HARD_QUOTA_COOLDOWN_MS)
          continueWork = false
        } else if (/429|too many requests|request limit|rate limit|fetch failed|timed?out/i.test(error?.message ?? '')) {
          continueWork = true
          retryDelayMs = 5_000
        }
      } finally {
        logPerf(mintAddress, perf, continueWork ? 'indexing' : 'ready-or-paused')
        runningMints.delete(mintAddress)
        if (continueWork) {
          setTimeout(() => {
            void getIndexedPumpGlobalFeeStats(connection, mintAddress, heliusRpcUrl)
          }, retryDelayMs)
        }
      }
    })()
  }
  if (stats.lifetimeGlobalFeesSol !== null) {
    if (process.env.NODE_ENV !== 'production') console.info(`[helius:fees] source=persisted-index resolved=0ms mint=${mintAddress}`)
    return stats
  }
  // This is one shared Helius-backed server index, never a visitor request.
  return stats
}
