import { PublicKey } from '@solana/web3.js'
import { cached } from './cache.mjs'
import { getConfig } from './config.mjs'
import { newestVisibleEvents, normalizePumpEvents } from './event-normalize.mjs'
import { decodePumpTradeEvents } from './pump-events.mjs'
import { canonicalPumpSwapPool, connectionFor, getPumpBondingCurve } from './solana.mjs'

// Vercel Functions are request scoped. This service deliberately reads a small
// recent window through RPC instead of opening a permanent WebSocket.
const EVENT_CACHE_TTL_MS = 2_000
const HISTORY_LIMIT = 8
const HISTORY_CONCURRENCY = 3
const EVENT_REQUEST_TIMEOUT_MS = 6_500

function withTimeout(promise, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), EVENT_REQUEST_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function readRecentEvents(config) {
  const rpcUrl = config.heliusRpcUrl ?? config.rpcUrl
  if (!config.mint || !rpcUrl) throw new Error('Event Log configuration is unavailable')

  const connection = connectionFor(rpcUrl)
  const mint = new PublicKey(config.mint)
  const curve = await withTimeout(getPumpBondingCurve(connection, config.mint), 'Pump curve lookup')
  if (!curve) throw new Error('Configured mint has no official Pump bonding curve')
  const pool = canonicalPumpSwapPool(config.mint)
  const targets = [curve.address, pool]

  const signatureGroups = await withTimeout(Promise.all(targets.map(async (target) => {
    const rows = await connection.getSignaturesForAddress(target, { limit: HISTORY_LIMIT })
    return rows.map((row) => ({ ...row, signature: row.signature }))
  })), 'Event Log signature lookup')

  const signatures = [...new Map(signatureGroups.flat()
    .filter((entry) => !entry.err)
    .sort((left, right) => (right.blockTime ?? 0) - (left.blockTime ?? 0))
    .map((entry) => [entry.signature, entry])).values()]
    .slice(0, HISTORY_LIMIT)

  const decodedGroups = await withTimeout(mapWithConcurrency(signatures, HISTORY_CONCURRENCY, async (entry) => {
    const transaction = await connection.getTransaction(entry.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (!transaction) return []
    const decoded = decodePumpTradeEvents({
      logMessages: transaction.meta?.logMessages,
      mint,
      pool,
      fallbackTimestampMs: entry.blockTime ? entry.blockTime * 1_000 : Date.now(),
    })
    return normalizePumpEvents(entry.signature, decoded)
  }), 'Event Log transaction lookup')

  return newestVisibleEvents(decodedGroups.flat())
}

/**
 * Request-driven, bounded Event Log source for serverless runtimes. Warm
 * instances reuse this short cache, while CDN response caching shares it
 * across visitors. Correctness never depends on either cache surviving.
 */
export async function getRecentHeartbeatEvents() {
  const config = getConfig()
  if (!config.mint) return []
  return cached(`recent-events:${config.mint}`, EVENT_CACHE_TTL_MS, () => readRecentEvents(config))
}
