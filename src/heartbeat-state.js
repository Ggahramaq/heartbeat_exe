export const MIN_ALIVE_BPM = 60
export const MAX_HEARTBEAT_BPM = 999
export const MAX_BALANCE_FOR_HEARTBEAT = 1_000

export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

// This is the single public heartbeat mapping used by every SURVIVE.EXE
// subsystem. It intentionally mirrors the main monitor's live/dead rule.
export function getSurviveHeartbeat(holderCount, balanceUsd) {
  if (holderCount === 0) return { isAlive: false, bpm: 0, progress: 0 }
  if (!Number.isFinite(balanceUsd)) {
    const progress = (74 - MIN_ALIVE_BPM) / (MAX_HEARTBEAT_BPM - MIN_ALIVE_BPM)
    return { isAlive: true, bpm: 74, progress }
  }
  const progress = clamp(balanceUsd / MAX_BALANCE_FOR_HEARTBEAT, 0, 1)
  return {
    isAlive: true,
    bpm: Math.round(MIN_ALIVE_BPM + progress * (MAX_HEARTBEAT_BPM - MIN_ALIVE_BPM)),
    progress,
  }
}
