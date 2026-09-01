import { useEffect, useMemo, useState } from 'react'

const INITIAL = {
  mint: null, rawHolderCount: null, holderCount: null, deploymentTimestamp: null,
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

export function useHeartbeatStatus() {
  const [data, setData] = useState(INITIAL)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let cancelled = false
    let refreshTimer
    const load = async () => {
      let hasUnresolvedFields = true
      try {
        const response = await fetch('/api/heartbeat-status')
        if (!response.ok) throw new Error(`Status request failed (${response.status})`)
        const snapshot = await response.json()
        hasUnresolvedFields = snapshot.holderCount === null || snapshot.balanceUsd === null
        if (!cancelled) {
          const resolved = Object.fromEntries(
            Object.entries(snapshot).filter(([key, value]) => value !== null || key === 'mint' || key === 'fetchedAt'),
          )
          setData((current) => snapshot.mint && snapshot.mint !== current.mint
            ? { ...INITIAL, ...snapshot }
            : { ...current, ...resolved })
        }
      } catch {
        // Retain the latest valid public snapshot during a transient failure.
      } finally {
        if (!cancelled) refreshTimer = window.setTimeout(load, hasUnresolvedFields ? 2_000 : 10_000)
      }
    }

    void load()
    const ageTimer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      cancelled = true
      window.clearInterval(ageTimer); window.clearTimeout(refreshTimer)
    }
  }, [])

  return useMemo(() => {
    const deploymentTimestamp = data.deploymentTimestamp
    const age = Number.isFinite(deploymentTimestamp) && deploymentTimestamp <= now ? formatAge(now - deploymentTimestamp) : 'LOADING...'
    const status = data.holderCount === null ? 'LOADING...' : data.holderCount === 0 ? 'DEAD' : 'ALIVE'
    const balance = Number.isFinite(data.balanceUsd) ? formatUsd(data.balanceUsd) : 'LOADING...'
    return {
      ...data, deploymentTimestamp, status, age, balance, earnedToday: balance,
      holderDisplay: data.holderCount === null ? 'LOADING...' : data.holderCount.toLocaleString('en-US'),
    }
  }, [data, now])
}
