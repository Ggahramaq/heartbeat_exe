import { getHeartbeatStatusPart, getHeartbeatStatusPlaceholder } from './status.mjs'

const STATUS_PART_TIMEOUT_MS = 1_750
const STATUS_PARTS = ['core', 'holders', 'fees', 'price']

function withTimeout(promise, part) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ _timedOut: part }), STATUS_PART_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

function mergeResolved(target, partial) {
  if (!partial || partial._timedOut || partial._pollError) return target
  for (const [key, value] of Object.entries(partial)) {
    if (value !== null || key === 'mint' || key === 'fetchedAt') target[key] = value
  }
  return target
}

function finalize(values) {
  const lifetime = values.lifetimeGlobalFeesSol
  const solUsd = values.currentSolUsdPrice
  const balanceUsd = lifetime === null || solUsd === null ? null : lifetime * solUsd
  const holderCount = values.holderCount
  return {
    ...values,
    status: holderCount === null ? null : holderCount === 0 ? 'DEAD' : 'ALIVE',
    ageMs: Number.isFinite(values.deploymentTimestamp)
      ? Math.max(0, Date.now() - values.deploymentTimestamp)
      : null,
    // Product semantics: EARNED TODAY intentionally equals BALANCE.
    todayGlobalFeesSol: lifetime,
    todayFeesSource: lifetime === null ? null : 'balance-equals-earned-today',
    balanceUsd,
    earnedTodayUsd: balanceUsd,
    fetchedAt: Date.now(),
  }
}

/**
 * Serverless-safe status resolution. Every invocation can start cold: CA is
 * present in the base response immediately and slow independent providers are
 * bounded so one timeout never blocks the rest of the public snapshot.
 */
export async function resolveHeartbeatStatusForRequest() {
  const initial = getHeartbeatStatusPlaceholder()
  const results = await Promise.allSettled(STATUS_PARTS.map(async (part) => withTimeout(getHeartbeatStatusPart(part), part)))
  const values = { ...initial }
  for (const result of results) {
    if (result.status === 'fulfilled') mergeResolved(values, result.value)
  }
  return finalize(values)
}
