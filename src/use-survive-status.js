import { useEffect, useMemo, useState } from 'react'

const INITIAL = {
  mint: null, rawHolderCount: null, holderCount: null, creationTimestamp: null,
  lifetimeGlobalFeesSol: null, todayGlobalFeesSol: null, currentSolUsdPrice: null,
}

function formatAge(ageMs) {
  const totalMinutes = Math.max(0, Math.floor(ageMs / 60_000))
  const minutes = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const hours = totalHours % 24
  const days = Math.floor(totalHours / 24)
  const pad = (number) => String(number).padStart(2, '0')
  if (days > 0) return `${pad(days)}D ${pad(hours)}H ${pad(minutes)}M`
  if (totalHours > 0) return `${pad(totalHours)}H ${pad(minutes)}M`
  return `${pad(minutes)}M`
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

export function useSurviveStatus() {
  const [data, setData] = useState(INITIAL)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let cancelled = false
    let refreshTimer
    const load = async () => {
      let hasUnresolvedFields = true
      try {
        const response = await fetch('/api/survive-status')
        if (!response.ok) throw new Error(`Status request failed (${response.status})`)
        const snapshot = await response.json()
        hasUnresolvedFields = snapshot.holderCount === null || snapshot.balanceUsd === null || snapshot.creationTimestamp === null
        if (!cancelled) {
          // The browser consumes a server-owned snapshot. Nulls mean the
          // backend is still resolving that value, not that an earlier value
          // should be erased by a partial response.
          const resolved = Object.fromEntries(
            Object.entries(snapshot).filter(([key, value]) => value !== null || key === 'mint' || key === 'fetchedAt'),
          )
          setData((current) => snapshot.mint && snapshot.mint !== current.mint
            ? { ...INITIAL, ...snapshot }
            : { ...current, ...resolved })
        }
      } catch {
        // Unavailable providers intentionally remain LOADING... in the UI.
      } finally {
        // A serverless cold start may intentionally publish CA plus partial
        // data. Retry only unresolved initial fields quickly; normal operation
        // continues at the existing ten-second cadence.
        if (!cancelled) refreshTimer = window.setTimeout(load, hasUnresolvedFields ? 2_000 : 10_000)
      }
    }

    void load()
    const ageTimer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(ageTimer); window.clearTimeout(refreshTimer)
    }
  }, [])

  return useMemo(() => {
    const age = data.creationTimestamp ? formatAge(now - data.creationTimestamp) : 'LOADING...'
    const status = data.holderCount === null ? 'LOADING...' : data.holderCount === 0 ? 'DEAD' : 'ALIVE'
    const balance = Number.isFinite(data.balanceUsd) ? formatUsd(data.balanceUsd) : 'LOADING...'
    // The main-page product rule intentionally displays EARNED TODAY as the
    // same resolved creator-earnings amount as BALANCE.
    const earnedToday = balance
    return {
      ...data, status, age, balance, earnedToday,
      holderDisplay: data.holderCount === null ? 'LOADING...' : data.holderCount.toLocaleString('en-US'),
    }
  }, [data, now])
}
