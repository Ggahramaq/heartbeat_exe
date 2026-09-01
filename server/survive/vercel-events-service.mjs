import { newestVisibleEvents, normalizePumpEvents } from './event-normalize.mjs'
import { decodePumpTradeEvents } from './pump-events.mjs'

const FIRST_SIGNATURE_PAGE = 16
const SECOND_SIGNATURE_PAGE = 8
const MAX_SIGNATURES = FIRST_SIGNATURE_PAGE + SECOND_SIGNATURE_PAGE
const TRANSACTION_CONCURRENCY = 3
const RPC_TIMEOUT_MS = 4_000
const CACHE_TTL_MS = 2_000
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const cache = new Map()

function configuredMint() { return process.env.HEARTBEAT_TOKEN_CA?.trim() || process.env.SURVIVE_TOKEN_CA?.trim() || null }

function configuredRpcUrl() {
  const value = process.env.SOLANA_RPC_URL?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch { return null }
}

// The Vercel event path intentionally avoids @solana/web3.js. The canonical
// decoder only needs the mint's raw 32 bytes to verify Pump trade events.
function base58ToBuffer(value) {
  let number = 0n
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) throw new Error('Configured token mint is not valid base58')
    number = number * 58n + BigInt(digit)
  }
  const bytes = []
  while (number > 0n) { bytes.push(Number(number & 255n)); number >>= 8n }
  for (const character of value) {
    if (character !== '1') break
    bytes.push(0)
  }
  const result = Buffer.from(bytes.reverse())
  if (result.length !== 32) throw new Error('Configured token mint must be 32 bytes')
  return result
}

function cached(key, loader) {
  const existing = cache.get(key)
  if (existing?.value && existing.expiresAt > Date.now()) return Promise.resolve(existing.value)
  if (existing?.promise) return existing.promise
  const promise = loader().then((value) => {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  }).catch((error) => { cache.delete(key); throw error })
  cache.set(key, { promise })
  return promise
}

async function rpc(url, method, params) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const providerResponse = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: `heartbeat-events-${Date.now()}`, method, params }),
    })
    const payload = await providerResponse.json().catch(() => null)
    if (!providerResponse.ok || payload?.error) throw new Error(payload?.error?.message ?? `Solana RPC returned ${providerResponse.status}`)
    return payload.result
  } finally { clearTimeout(timeout) }
}

async function signaturesForMint(url, mint, before, limit) {
  const result = await rpc(url, 'getSignaturesForAddress', [mint, { limit, ...(before ? { before } : {}) }])
  return Array.isArray(result) ? result.filter((entry) => !entry?.err && typeof entry?.signature === 'string') : []
}

async function decodeCandidates(url, entries, mint) {
  const events = []
  for (let offset = 0; offset < entries.length && newestVisibleEvents(events).length < 5; offset += TRANSACTION_CONCURRENCY) {
    const batch = entries.slice(offset, offset + TRANSACTION_CONCURRENCY)
    const decoded = await Promise.all(batch.map(async (entry) => {
      try {
        const transaction = await rpc(url, 'getTransaction', [entry.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
        if (!transaction) return []
        const trades = decodePumpTradeEvents({
          logMessages: transaction.meta?.logMessages,
          mint,
          pool: null,
          allowUnverifiedAmm: true,
          fallbackTimestampMs: transaction.blockTime ? transaction.blockTime * 1_000 : (entry.blockTime ? entry.blockTime * 1_000 : Date.now()),
        })
        return normalizePumpEvents(entry.signature, trades)
      } catch (error) {
        console.error('[events] transaction skipped', { name: error?.name, message: error?.message, stack: error?.stack })
        return []
      }
    }))
    events.push(...decoded.flat())
  }
  return newestVisibleEvents(events)
}

async function loadRecentEvents() {
  const mintAddress = configuredMint()
  const url = configuredRpcUrl()
  if (!mintAddress || !url) return []
  const mint = { toBuffer: () => base58ToBuffer(mintAddress) }
  console.log('[events] fetching recent signatures')
  const firstPage = await signaturesForMint(url, mintAddress, null, FIRST_SIGNATURE_PAGE)
  let candidates = firstPage.slice(0, MAX_SIGNATURES)
  let events = await decodeCandidates(url, candidates, mint)
  if (events.length < 5 && firstPage.length === FIRST_SIGNATURE_PAGE) {
    const before = firstPage.at(-1)?.signature
    const secondPage = before ? await signaturesForMint(url, mintAddress, before, SECOND_SIGNATURE_PAGE) : []
    const known = new Set(candidates.map((entry) => entry.signature))
    const additionalCandidates = secondPage.filter((entry) => !known.has(entry.signature)).slice(0, SECOND_SIGNATURE_PAGE)
    candidates = [...candidates, ...additionalCandidates].slice(0, MAX_SIGNATURES)
    const additionalEvents = await decodeCandidates(url, additionalCandidates, mint)
    events = newestVisibleEvents([...events, ...additionalEvents])
  }
  console.log(`[events] signatures=${candidates.length}`)
  console.log(`[events] normalized=${events.length}`)
  return events
}

/** Bounded HTTP-RPC source for Vercel. It never opens a WebSocket. */
export async function getRecentVercelEvents() {
  const mint = configuredMint()
  return mint ? cached(`events:${mint}`, loadRecentEvents) : []
}
