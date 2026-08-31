import { readMintIndex, writeMintIndex } from './index-store.mjs'
import { easternMidnightUtcMs } from './time.mjs'

const ENDPOINT = 'https://public-api.birdeye.so/defi/token_overview'
const BOOTSTRAP_KIND = 'birdeye-global-fees-v1'
const FAST_PATH_TARGET_MS = 3_000
const MAX_EXPECTED_MS = 5_000
// One shared Overview request serves balance and holders. Its short lifetime
// matches the server snapshot cadence and includes an in-flight promise, so
// concurrent consumers never duplicate a Birdeye request.
const OVERVIEW_TTL_MS = 9_000
// Preserve the last server snapshot after a provider throttle, but retry on
// the next normal status cycle instead of suppressing a new balance for an
// hour.
const QUOTA_COOLDOWN_MS = 10_000
const overviewCache = new Map()
let overviewUnavailableUntil = 0

function toLamports(value) {
  const sol = Number(value)
  if (!Number.isFinite(sol) || sol < 0) return null
  return BigInt(Math.round(sol * 1_000_000_000)).toString()
}

function statsFromBootstrap(bootstrap, creationTimestamp) {
  if (!bootstrap || bootstrap.kind !== BOOTSTRAP_KIND) return null
  const lifetime = Number(BigInt(bootstrap.lifetimeGlobalFeesLamports)) / 1_000_000_000
  // A token created today did not exist before Eastern midnight, so today's
  // global fee total is exactly its all-time total. Do not use a 24h proxy.
  const today = creationTimestamp && creationTimestamp >= easternMidnightUtcMs() ? lifetime : null
  return {
    lifetimeGlobalFeesSol: lifetime,
    todayGlobalFeesSol: today,
    feeSource: 'birdeye-bootstrap',
  }
}

async function requestJson(endpoint, mint, apiKey) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FAST_PATH_TARGET_MS)
  try {
    const url = new URL(endpoint)
    url.searchParams.set('address', mint)
    const response = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      let providerMessage = ''
      try {
        const body = await response.json()
        providerMessage = typeof body?.message === 'string' ? `: ${body.message}` : ''
      } catch {
        // A non-JSON provider error still carries the useful HTTP status.
      }
      const error = new Error(`Birdeye ${new URL(endpoint).pathname} returned ${response.status}${providerMessage}`)
      error.status = response.status
      error.providerMessage = providerMessage
      throw error
    }
    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}

export async function getBirdeyeTokenOverview(mint) {
  const apiKey = process.env.BIRDEYE_API_KEY?.trim()
  if (!apiKey) return null
  const cached = overviewCache.get(mint)
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value
  if (cached?.promise) return cached.promise
  if (overviewUnavailableUntil > Date.now()) return null

  const startedAt = performance.now()
  if (process.env.NODE_ENV !== 'production') console.info(`[balance] requesting Birdeye overview mint=${mint}`)
  const promise = requestJson(ENDPOINT, mint, apiKey)
    .then((body) => {
      const data = body?.data
      // `holder` and `global_fees_paid` are Birdeye's documented Overview
      // property names. Missing/invalid values remain null-never zero.
      const holder = Number(data?.holder)
      const rawHolderCount = Number.isFinite(holder) && holder >= 0 ? Math.trunc(holder) : null
      const globalFeesLamports = toLamports(data?.global_fees_paid)
      const value = { rawHolderCount, globalFeesLamports, resolvedMs: Math.round(performance.now() - startedAt) }
      overviewCache.set(mint, { value, expiresAt: Date.now() + OVERVIEW_TTL_MS })
      if (process.env.NODE_ENV !== 'production') {
        console.info(`[survive] overview source=birdeye-token-overview resolved=${value.resolvedMs}ms rawHolder=${rawHolderCount ?? 'missing'} mint=${mint}`)
        console.info(`[birdeye:overview] fields=${Object.keys(data ?? {}).join(',')}`)
      }
      return value
    })
    .catch((error) => {
      overviewCache.delete(mint)
      if (/compute units usage limit exceeded/i.test(error.message)) {
        overviewUnavailableUntil = Date.now() + QUOTA_COOLDOWN_MS
      }
      if (process.env.NODE_ENV !== 'production') console.warn(`[birdeye] token overview unavailable: ${error.message}`)
      return null
    })
  overviewCache.set(mint, { promise, expiresAt: Date.now() + OVERVIEW_TTL_MS })
  return promise
}

// One cold-start request per mint. The result is persisted and served by our
// own API thereafter; Birdeye is never contacted by a website visitor.
export async function getOrCreateBirdeyeFeeBootstrap(mint, { refresh = false } = {}) {
  const stored = (await readMintIndex(mint)) ?? {}
  const cached = statsFromBootstrap(stored.feeBootstrap, stored.creationTimestamp)
  if (cached && !refresh) {
    if (process.env.NODE_ENV !== 'production') console.info(`[balance] source=persisted-birdeye-bootstrap resolved=0ms mint=${mint}`)
    return { ...cached, resolvedMs: 0, cached: true }
  }

  const startedAt = performance.now()
  try {
    const overview = await getBirdeyeTokenOverview(mint)
    if (!overview?.globalFeesLamports) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[balance:error] Birdeye global_fees_paid unavailable mint=${mint}; using persisted/native fallback`)
      }
      return cached
    }
    const lifetimeGlobalFeesLamports = overview.globalFeesLamports
    const bootstrap = {
      kind: BOOTSTRAP_KIND,
      source: 'birdeye-token-overview',
      lifetimeGlobalFeesLamports,
      capturedAt: Date.now(),
    }
    await writeMintIndex(mint, { feeBootstrap: bootstrap })
    const resolvedMs = Math.round(performance.now() - startedAt)
    const stats = statsFromBootstrap(bootstrap, stored.creationTimestamp)
    if (process.env.NODE_ENV !== 'production') {
      const target = resolvedMs <= FAST_PATH_TARGET_MS ? 'target-met' : resolvedMs <= MAX_EXPECTED_MS ? 'acceptable' : 'slow'
      console.info(`[balance] source=birdeye-bootstrap globalFees=${stats.lifetimeGlobalFeesSol}SOL resolved=${resolvedMs}ms ${target} mint=${mint}`)
    }
    return { ...stats, resolvedMs, cached: false }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') console.warn(`[balance] source=birdeye-bootstrap unavailable: ${error.message}`)
    return cached
  }
}
