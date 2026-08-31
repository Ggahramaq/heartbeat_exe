const BIRDEYE_TOKEN_OVERVIEW_URL = 'https://public-api.birdeye.so/defi/token_overview'
const BIRDEYE_TOKEN_CREATION_URL = 'https://public-api.birdeye.so/defi/token_creation_info'
const BIRDEYE_PRICE_URL = 'https://public-api.birdeye.so/defi/price'
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112'
const REQUEST_TIMEOUT_MS = 1_600
const CACHE_TTL_MS = 9_000

// Vercel instances can reuse this cache when warm, but every request still
// works correctly after a cold start because no value is required to exist.
const cache = new Map()

function publicMint() {
  return process.env.SURVIVE_TOKEN_CA?.trim() || null
}

function emptyStatus(mint) {
  return {
    mint,
    ca: mint,
    status: null,
    rawHolderCount: null,
    holderCount: null,
    creationTimestamp: null,
    ageMs: null,
    lifetimeGlobalFeesSol: null,
    todayGlobalFeesSol: null,
    currentSolUsdPrice: null,
    balanceUsd: null,
    earnedTodayUsd: null,
    feeSource: null,
    globalFeeSource: null,
    holderSource: null,
    birthSource: null,
    todayFeesSource: null,
    fetchedAt: Date.now(),
  }
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function timestampOrNull(value) {
  const number = typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())
    ? Date.parse(value)
    : Number(value)
  if (!Number.isFinite(number)) return null
  const milliseconds = number < 10_000_000_000 ? number * 1_000 : number
  return milliseconds > 1_500_000_000_000 && milliseconds <= Date.now() + 60_000
    ? Math.round(milliseconds)
    : null
}

function findTimestamp(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null
  const timestampKeys = new Set([
    'blocktime', 'block_time', 'creationtime', 'creation_time', 'createdat',
    'created_at', 'createdtime', 'created_time', 'timestamp', 'listingtime',
    'listing_time', 'launchtime', 'launch_time', 'launchat', 'launch_at',
  ])
  for (const [key, candidate] of Object.entries(value)) {
    if (timestampKeys.has(key.toLowerCase())) {
      const timestamp = timestampOrNull(candidate)
      if (timestamp !== null) return timestamp
    }
    const nested = findTimestamp(candidate, depth + 1)
    if (nested !== null) return nested
  }
  return null
}

async function fetchBirdeye(url, address) {
  const apiKey = process.env.BIRDEYE_API_KEY?.trim()
  if (!apiKey) throw new Error('BIRDEYE_API_KEY is not configured')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const requestUrl = new URL(url)
    requestUrl.searchParams.set('address', address)
    const providerResponse = await fetch(requestUrl, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', accept: 'application/json' },
      signal: controller.signal,
    })
    if (!providerResponse.ok) throw new Error(`Birdeye request returned ${providerResponse.status}`)
    return providerResponse.json()
  } finally {
    clearTimeout(timeout)
  }
}

function cached(key, loader) {
  const existing = cache.get(key)
  if (existing?.value && existing.expiresAt > Date.now()) return Promise.resolve(existing.value)
  if (existing?.promise) return existing.promise
  const promise = loader()
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      return value
    })
    .catch((error) => {
      cache.delete(key)
      throw error
    })
  cache.set(key, { promise })
  return promise
}

async function resolveOverview(mint) {
  const body = await cached(`overview:${mint}`, () => fetchBirdeye(BIRDEYE_TOKEN_OVERVIEW_URL, mint))
  const data = body?.data ?? {}
  const rawHolderCount = numberOrNull(data.holder)
  const globalFeesPaidSol = numberOrNull(data.global_fees_paid)
  return {
    rawHolderCount: rawHolderCount === null ? null : Math.trunc(rawHolderCount),
    globalFeesPaidSol,
  }
}

async function resolveSolUsdPrice() {
  const body = await cached('sol-usd', () => fetchBirdeye(BIRDEYE_PRICE_URL, WRAPPED_SOL_MINT))
  return numberOrNull(body?.data?.value ?? body?.data?.price)
}

async function resolveBirthTimestamp(mint) {
  const body = await cached(`birth:${mint}`, () => fetchBirdeye(BIRDEYE_TOKEN_CREATION_URL, mint))
  return findTimestamp(body?.data)
}

function reportPartFailure(part, error) {
  console.error('[survive-status:provider]', {
    part,
    name: error?.name,
    message: error?.message,
    stack: error?.stack,
  })
}

/**
 * Vercel-only status resolver. It deliberately has no imports from the local
 * poller, filesystem index, WebSocket event log, or Solana web3 stack.
 */
export async function resolveVercelSurviveStatus() {
  const mint = publicMint()
  const result = emptyStatus(mint)
  console.log('[survive-status] start')
  console.log('[survive-status] env', {
    hasCA: Boolean(mint),
    hasBirdeye: Boolean(process.env.BIRDEYE_API_KEY?.trim()),
    hasRpc: Boolean(process.env.SOLANA_RPC_URL?.trim()),
  })
  if (!mint) return result

  console.log('[survive-status] resolving birdeye')
  console.log('[survive-status] resolving holders')
  const [overviewResult, priceResult, birthResult] = await Promise.allSettled([
    resolveOverview(mint),
    resolveSolUsdPrice(),
    resolveBirthTimestamp(mint),
  ])

  if (overviewResult.status === 'fulfilled') {
    const { rawHolderCount, globalFeesPaidSol } = overviewResult.value
    if (rawHolderCount !== null) {
      result.rawHolderCount = rawHolderCount
      result.holderCount = Math.max(rawHolderCount - 1, 0)
      result.holderSource = 'birdeye-token-overview'
      result.status = result.holderCount === 0 ? 'DEAD' : 'ALIVE'
    }
    if (globalFeesPaidSol !== null) {
      result.lifetimeGlobalFeesSol = globalFeesPaidSol
      result.todayGlobalFeesSol = globalFeesPaidSol
      result.feeSource = 'birdeye-token-overview'
      result.globalFeeSource = 'birdeye-token-overview'
      result.todayFeesSource = 'balance-equals-earned-today'
    }
  } else {
    reportPartFailure('birdeye-overview', overviewResult.reason)
  }

  if (priceResult.status === 'fulfilled') {
    result.currentSolUsdPrice = priceResult.value
  } else {
    reportPartFailure('sol-usd-price', priceResult.reason)
  }

  if (birthResult.status === 'fulfilled' && birthResult.value !== null) {
    result.creationTimestamp = birthResult.value
    result.ageMs = Math.max(0, Date.now() - birthResult.value)
    result.birthSource = 'birdeye-token-creation-info'
  } else if (birthResult.status === 'rejected') {
    reportPartFailure('birth', birthResult.reason)
  }

  if (result.lifetimeGlobalFeesSol !== null && result.currentSolUsdPrice !== null) {
    result.balanceUsd = result.lifetimeGlobalFeesSol * result.currentSolUsdPrice
    // Product decision: earned today intentionally mirrors balance.
    result.earnedTodayUsd = result.balanceUsd
  }
  result.fetchedAt = Date.now()
  return result
}

export function getVercelStatusPlaceholder() {
  return emptyStatus(publicMint())
}
