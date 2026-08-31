import { SURVIVE_DEPLOYED_AT } from './generated-build-info.mjs'

const BIRDEYE_TOKEN_OVERVIEW_URL = 'https://public-api.birdeye.so/defi/token_overview'
const BIRDEYE_PRICE_URL = 'https://public-api.birdeye.so/defi/price'
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112'
const REQUEST_TIMEOUT_MS = 1_600
const CACHE_TTL_MS = 9_000
const cache = new Map()

function publicMint() { return process.env.SURVIVE_TOKEN_CA?.trim() || null }

function emptyStatus(mint) {
  return {
    mint,
    ca: mint,
    status: null,
    rawHolderCount: null,
    holderCount: null,
    // Deployment time is the one explicit source of truth for all uptime UI.
    deploymentTimestamp: SURVIVE_DEPLOYED_AT,
    ageMs: Math.max(0, Date.now() - SURVIVE_DEPLOYED_AT),
    ageSource: 'build',
    birthSource: 'build',
    lifetimeGlobalFeesSol: null,
    todayGlobalFeesSol: null,
    currentSolUsdPrice: null,
    balanceUsd: null,
    earnedTodayUsd: null,
    feeSource: null,
    globalFeeSource: null,
    holderSource: null,
    todayFeesSource: null,
    fetchedAt: Date.now(),
  }
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
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
  } finally { clearTimeout(timeout) }
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

async function resolveOverview(mint) {
  const body = await cached(`overview:${mint}`, () => fetchBirdeye(BIRDEYE_TOKEN_OVERVIEW_URL, mint))
  const data = body?.data ?? {}
  const rawHolderCount = numberOrNull(data.holder)
  return {
    rawHolderCount: rawHolderCount === null ? null : Math.trunc(rawHolderCount),
    globalFeesPaidSol: numberOrNull(data.global_fees_paid),
  }
}

async function resolveSolUsdPrice() {
  const body = await cached('sol-usd', () => fetchBirdeye(BIRDEYE_PRICE_URL, WRAPPED_SOL_MINT))
  return numberOrNull(body?.data?.value ?? body?.data?.price)
}

function reportPartFailure(part, error) {
  console.error('[survive-status:provider]', {
    part, name: error?.name, message: error?.message, stack: error?.stack,
  })
}

/** Vercel-safe request resolver; no token-birth provider or RPC work occurs. */
export async function resolveVercelSurviveStatus() {
  const mint = publicMint()
  const result = emptyStatus(mint)
  console.log('[survive-status] start')
  console.log('[survive-status] env', {
    hasCA: Boolean(mint),
    hasBirdeye: Boolean(process.env.BIRDEYE_API_KEY?.trim()),
    hasRpc: Boolean(process.env.SOLANA_RPC_URL?.trim()),
  })
  console.log(`[age] source=build deploymentTimestamp=${SURVIVE_DEPLOYED_AT}`)
  if (!mint) return result

  console.log('[survive-status] resolving birdeye')
  console.log('[survive-status] resolving holders')
  const [overviewResult, priceResult] = await Promise.allSettled([
    resolveOverview(mint),
    resolveSolUsdPrice(),
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

  if (priceResult.status === 'fulfilled') result.currentSolUsdPrice = priceResult.value
  else reportPartFailure('sol-usd-price', priceResult.reason)

  if (result.lifetimeGlobalFeesSol !== null && result.currentSolUsdPrice !== null) {
    result.balanceUsd = result.lifetimeGlobalFeesSol * result.currentSolUsdPrice
    result.earnedTodayUsd = result.balanceUsd
  }
  result.fetchedAt = Date.now()
  result.ageMs = Math.max(0, result.fetchedAt - SURVIVE_DEPLOYED_AT)
  return result
}

export function getVercelStatusPlaceholder() {
  return emptyStatus(publicMint())
}
