import { getSurviveStatusPart, getSurviveStatusPlaceholder } from './status.mjs'

const POLL_INTERVAL_MS = 10_000
const PARTS = ['core', 'holders', 'fees', 'price']

let snapshot = null
let timer = null
const inFlight = new Set()
const retryAfter = new Map()
let lastFinancialLog = ''

function completeSnapshot(values) {
  const lifetime = values.lifetimeGlobalFeesSol
  // Product semantics: EARNED TODAY mirrors BALANCE. This deliberately
  // avoids a second date-bounded accounting path and guarantees both fields
  // resolve together from the same global-fee total.
  const today = lifetime
  const todayFeesSource = lifetime === null ? null : 'balance-equals-earned-today'
  const solUsd = values.currentSolUsdPrice
  const balanceUsd = lifetime === null || solUsd === null ? null : lifetime * solUsd
  return {
    ...values,
    todayGlobalFeesSol: today,
    todayFeesSource,
    ageMs: values.creationTimestamp === null ? null : Math.max(0, Date.now() - values.creationTimestamp),
    balanceUsd,
    earnedTodayUsd: balanceUsd,
    fetchedAt: Date.now(),
  }
}

function mergePart(partial) {
  const current = snapshot ?? getSurviveStatusPlaceholder()
  // Changing the configured mint is a new machine. Never mix values indexed
  // for the previous mint into the new mint's snapshot.
  const target = partial.mint && partial.mint !== current.mint
    ? getSurviveStatusPlaceholder()
    : current
  const resolved = Object.fromEntries(
    Object.entries(partial).filter(([key, value]) => value !== null || key === 'mint' || key === 'fetchedAt'),
  )
  snapshot = completeSnapshot({ ...target, ...resolved })
  if (process.env.NODE_ENV !== 'production') {
    const financialLog = JSON.stringify([
      snapshot.mint, snapshot.lifetimeGlobalFeesSol, snapshot.todayGlobalFeesSol,
      snapshot.currentSolUsdPrice, snapshot.balanceUsd, snapshot.earnedTodayUsd,
    ])
    if (financialLog !== lastFinancialLog && (
      snapshot.lifetimeGlobalFeesSol !== null || snapshot.currentSolUsdPrice !== null
    )) {
      lastFinancialLog = financialLog
      console.info(
        `[balance-fast] snapshot committed mint=${snapshot.mint} source=${snapshot.feeSource ?? 'unresolved'} `
        + `globalFeesPaid=${snapshot.lifetimeGlobalFeesSol === null ? 'LOADING' : `${snapshot.lifetimeGlobalFeesSol} SOL`} `
        + `SOL/USD=${snapshot.currentSolUsdPrice ?? 'LOADING'} `
        + `balance=${snapshot.balanceUsd === null ? 'LOADING' : `$${snapshot.balanceUsd.toFixed(2)}`} `
        + `earnedToday=${snapshot.earnedTodayUsd === null ? 'LOADING' : `$${snapshot.earnedTodayUsd.toFixed(2)}`} `
        + `overviewMs=${snapshot.overviewResolvedMs ?? 'LOADING'} priceMs=${snapshot.priceResolvedMs ?? 'LOADING'}`,
      )
    }
  }
}

async function refreshPart(part) {
  if (inFlight.has(part)) return
  if ((retryAfter.get(part) ?? 0) > Date.now()) return
  inFlight.add(part)
  try {
    const partial = await getSurviveStatusPart(part)
    if (partial._pollError) throw new Error(partial._pollError)
    mergePart(partial)
  } catch (error) {
    // A creation scan that reaches its safety guard cannot become valid on
    // the next ten-second tick. Back it off long enough to protect the RPC;
    // transient provider errors retry on the next normal cycle.
    const delay = /daily request limit|monthly request limit|quota (?:is )?exceeded|usage limit exceeded/i.test(error.message)
      ? 60 * 60_000
      : /safe creation scan limit/i.test(error.message) ? 5 * 60_000 : POLL_INTERVAL_MS
    retryAfter.set(part, Date.now() + delay)
    if (process.env.NODE_ENV !== 'production') console.warn(`[survive-poller:${part}]`, error.message)
  } finally {
    inFlight.delete(part)
  }
}

function refresh() {
  // Each part has its own lock: an initial historical creation scan may run
  // for a while, but it cannot prevent holders, price, or fee-index progress
  // from being published every polling cycle.
  for (const part of PARTS) void refreshPart(part)
}

export function startSurviveStatusPoller() {
  if (timer) return
  snapshot = getSurviveStatusPlaceholder()
  refresh()
  timer = setInterval(refresh, POLL_INTERVAL_MS)
}

export function getSurviveStatusSnapshot() {
  return completeSnapshot(snapshot ?? getSurviveStatusPlaceholder())
}

export function stopSurviveStatusPoller() {
  if (timer) clearInterval(timer)
  timer = null
}
