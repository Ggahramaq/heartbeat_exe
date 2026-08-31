import { readMintIndex, writeMintIndex } from './index-store.mjs'
import { easternMidnightUtcMs } from './time.mjs'

const ENDPOINT = 'https://public-api.birdeye.so/defi/token_overview'
const MEME_DETAIL_ENDPOINT = 'https://public-api.birdeye.so/defi/v3/token/meme/detail/single'
const CREATION_INFO_ENDPOINT = 'https://public-api.birdeye.so/defi/token_creation_info'
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
let creationInfoAvailable
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

function normalizeTimestamp(value) {
  const number = typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())
    ? Date.parse(value)
    : Number(value)
  if (!Number.isFinite(number)) return null
  const ms = number < 10_000_000_000 ? number * 1_000 : number
  return ms > 1_500_000_000_000 && ms <= Date.now() + 60_000 ? Math.round(ms) : null
}

function firstTimestamp(value, keys) {
  if (!value || typeof value !== 'object') return null
  for (const [key, candidate] of Object.entries(value)) {
    if (keys.has(key.toLowerCase())) {
      const timestamp = normalizeTimestamp(candidate)
      if (timestamp !== null) return timestamp
    }
    if (candidate && typeof candidate === 'object') {
      const timestamp = firstTimestamp(candidate, keys)
      if (timestamp !== null) return timestamp
    }
  }
  return null
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

export async function getBirdeyeBirthTimestamp(mint) {
  const stored = (await readMintIndex(mint)) ?? {}
  if (stored.birdeyeBirth?.timestampMs) return { timestampMs: stored.birdeyeBirth.timestampMs, source: stored.birdeyeBirth.source, resolvedMs: 0 }
  const apiKey = process.env.BIRDEYE_API_KEY?.trim()
  if (!apiKey) return null

  const startedAt = performance.now()
  const creation = creationInfoAvailable === false
    ? Promise.resolve(null)
    : requestJson(CREATION_INFO_ENDPOINT, mint, apiKey).catch((error) => {
      if (error.status === 401 || error.status === 403) creationInfoAvailable = false
      if (process.env.NODE_ENV !== 'production') console.warn(`[birdeye:birth] creation-info unavailable: ${error.message}`)
      return null
    })
  const meme = requestJson(MEME_DETAIL_ENDPOINT, mint, apiKey).catch((error) => {
    if (process.env.NODE_ENV !== 'production') console.warn(`[birdeye:birth] meme-detail unavailable: ${error.message}`)
    return null
  })
  const [creationBody, memeBody] = await Promise.all([creation, meme])
  if (process.env.NODE_ENV !== 'production') {
    console.info(`[birdeye:birth] creationFields=${Object.keys(creationBody?.data ?? {}).join(',')} memeFields=${Object.keys(memeBody?.data ?? {}).join(',')}`)
  }
  const creationTimestamp = firstTimestamp(creationBody?.data, new Set(['blocktime', 'block_time', 'creationtime', 'creation_time', 'createdat', 'created_at', 'createdtime', 'created_time', 'timestamp']))
  const memeTimestamp = firstTimestamp(memeBody?.data, new Set(['listingtime', 'listing_time', 'listingat', 'listing_at', 'listtime', 'list_time', 'launchtime', 'launch_time', 'launchat', 'launch_at', 'createdat', 'created_at', 'createdtime', 'created_time', 'timestamp']))
  const timestampMs = creationTimestamp ?? memeTimestamp
  if (timestampMs === null) {
    if (process.env.NODE_ENV !== 'production') console.warn(`[birdeye] birth timestamp missing for mint=${mint}`)
    return null
  }
  const source = creationTimestamp !== null ? 'birdeye-creation-info' : 'birdeye-meme-detail'
  const resolvedMs = Math.round(performance.now() - startedAt)
  if (process.env.NODE_ENV !== 'production') console.info(`[age] timestamp candidate=${timestampMs} normalized=${timestampMs} source=${source} mint=${mint}`)
  await writeMintIndex(mint, { birdeyeBirth: { timestampMs, source, cachedAt: Date.now() } })
  if (process.env.NODE_ENV !== 'production') console.info(`[survive] birth=${new Date(timestampMs).toISOString()} source=${source} resolved=${resolvedMs}ms mint=${mint}`)
  return { timestampMs, source, resolvedMs }
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
