const BIRDEYE_TOKEN_OVERVIEW_URL = 'https://public-api.birdeye.so/defi/token_overview'
const BIRDEYE_TOKEN_CREATION_URL = 'https://public-api.birdeye.so/defi/token_creation_info'
const BIRDEYE_PRICE_URL = 'https://public-api.birdeye.so/defi/price'
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112'
const REQUEST_TIMEOUT_MS = 1_600
const CACHE_TTL_MS = 9_000
const BIRTH_RPC_PAGE_LIMIT = 250
const BIRTH_RPC_MAX_PAGES = 3

// Vercel instances can reuse this cache when warm, but every request still
// works correctly after a cold start because no value is required to exist.
const cache = new Map()

function publicMint() {
  return process.env.SURVIVE_TOKEN_CA?.trim() || null
}

// This value is deliberately milliseconds only. Rejecting ambiguous seconds
// prevents a typo from turning into a plausible-looking but incorrect uptime.
function configuredBirthTimestamp() {
  const raw = process.env.SURVIVE_BIRTH_TIMESTAMP?.trim()
  if (!raw) return null
  if (!/^\d{13,}$/.test(raw)) {
    console.warn('[age] failed reason=SURVIVE_BIRTH_TIMESTAMP must be Unix milliseconds')
    return null
  }
  const timestamp = timestampOrNull(raw)
  if (timestamp === null) console.warn('[age] failed reason=SURVIVE_BIRTH_TIMESTAMP is invalid or in the future')
  return timestamp
}

function emptyStatus(mint) {
  return {
    mint,
    ca: mint,
    status: null,
    rawHolderCount: null,
    holderCount: null,
    birthTimestamp: null,
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
    ageSource: null,
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
  try {
    const body = await fetchBirdeye(BIRDEYE_TOKEN_CREATION_URL, mint)
    const timestamp = findTimestamp(body?.data)
    if (timestamp !== null) {
      console.log(`[age] source=birdeye creationTimestamp=${timestamp}`)
      return { timestamp, source: 'birdeye' }
    }
    console.warn('[age] failed reason=Birdeye creation response had no valid timestamp')
  } catch (error) {
    console.warn(`[age] failed reason=Birdeye creation lookup: ${error?.message ?? 'unknown error'}`)
  }

  const rpcUrl = process.env.SOLANA_RPC_URL?.trim()
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is not configured for birth fallback')
  try {
    new URL(rpcUrl)
  } catch {
    throw new Error('SOLANA_RPC_URL is invalid for birth fallback')
  }

  let before
  for (let page = 0; page < BIRTH_RPC_MAX_PAGES; page += 1) {
    const payload = await fetchSolanaRpc(rpcUrl, 'getSignaturesForAddress', [mint, {
      limit: BIRTH_RPC_PAGE_LIMIT,
      ...(before ? { before } : {}),
    }])
    const signatures = Array.isArray(payload) ? payload.filter((entry) => !entry?.err) : []
    if (!signatures.length) throw new Error('Solana RPC returned no successful mint signatures')
    // RPC is newest-first. A short page means its last entry is the actual
    // earliest available mint-related transaction, not a server first-seen time.
    if (signatures.length < BIRTH_RPC_PAGE_LIMIT) {
      const timestamp = timestampOrNull(signatures.at(-1)?.blockTime)
      if (timestamp === null) throw new Error('Earliest Solana mint signature has no valid block time')
      console.log(`[age] source=solana-rpc creationTimestamp=${timestamp}`)
      return { timestamp, source: 'solana-rpc' }
    }
    before = signatures.at(-1)?.signature
  }
  throw new Error(`Solana mint history exceeded bounded birth lookup (${BIRTH_RPC_MAX_PAGES * BIRTH_RPC_PAGE_LIMIT} signatures)`)
}

async function fetchSolanaRpc(url, method, params) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const providerResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: `survive-age-${Date.now()}`, method, params }),
    })
    const payload = await providerResponse.json().catch(() => null)
    if (!providerResponse.ok || payload?.error) throw new Error(payload?.error?.message ?? `Solana RPC returned ${providerResponse.status}`)
    return payload.result
  } finally {
    clearTimeout(timeout)
  }
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
  console.log('[age] starting')
  console.log(`[age] mint=${mint}`)
  const environmentBirth = configuredBirthTimestamp()
  if (environmentBirth !== null) console.log(`[age] source=env creationTimestamp=${environmentBirth}`)
  const [overviewResult, priceResult, birthResult] = await Promise.allSettled([
    resolveOverview(mint),
    resolveSolUsdPrice(),
    environmentBirth === null
      ? cached(`birth:${mint}`, () => resolveBirthTimestamp(mint))
      : Promise.resolve({ timestamp: environmentBirth, source: 'env' }),
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

  if (birthResult.status === 'fulfilled' && Number.isFinite(birthResult.value?.timestamp)) {
    const { timestamp, source } = birthResult.value
    result.birthTimestamp = timestamp
    // Keep the legacy field as an alias while all UI consumers move to the
    // explicit birthTimestamp contract.
    result.creationTimestamp = timestamp
    result.ageMs = Math.max(0, Date.now() - timestamp)
    result.birthSource = source
    result.ageSource = source
    console.log(`[age] resolved birth timestamp: ${timestamp}`)
    if (source !== 'env') console.log(`[age] recommended Vercel env: SURVIVE_BIRTH_TIMESTAMP=${timestamp}`)
  } else if (birthResult.status === 'rejected') {
    reportPartFailure('birth', birthResult.reason)
    console.warn(`[age] failed reason=${birthResult.reason?.message ?? 'unknown error'}`)
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
