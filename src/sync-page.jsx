import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BootSection, InstantBootSection } from './boot-section.jsx'
import { getHeartbeat, MAX_HEARTBEAT_BPM } from './heartbeat-state.js'
import { useSubsystemSequence } from './use-subsystem-sequence.js'
import { useHeartbeatStatus } from './use-heartbeat-status.js'

const SYNC_BOOT_ORDER = ['title', 'myHeart', 'yourHeart', 'comparison', 'tap', 'result', 'back']
const INACTIVITY_MS = 2_800
const MIN_TAP_INTERVAL_MS = 31
const PULSE_WINDOW_MS = 2_800

function navigate(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[midpoint] : (ordered[midpoint - 1] + ordered[midpoint]) / 2
}

function PanelHeader({ children }) {
  return <div className="panel-header"><span>{children}</span><span className="stripes" /></div>
}

function userPulsePath(taps, now) {
  const beginning = now - PULSE_WINDOW_MS
  const visibleTaps = taps.filter((tap) => tap >= beginning)
  let path = 'M0 39'
  let previousX = 0
  for (const tap of visibleTaps) {
    const x = Math.max(10, Math.min(290, ((tap - beginning) / PULSE_WINDOW_MS) * 300))
    const start = Math.max(previousX, x - 8)
    path += ` H${start} L${x - 3} 34 L${x} 14 L${x + 4} 59 L${x + 9} 39`
    previousX = x + 9
  }
  return `${path} H300`
}

function SyncWave({ kind, bpm, taps = [], now = performance.now() }) {
  const dead = kind === 'mine' && bpm === 0
  const isMax = kind === 'mine' && bpm === MAX_HEARTBEAT_BPM
  const userPath = userPulsePath(taps, now)
  const speedProgress = Math.min(Math.max((bpm - 60) / (MAX_HEARTBEAT_BPM - 60), 0), 1)
  const scanDuration = 4 - speedProgress * 3.38
  return <svg className={`sync-wave ${dead ? 'is-dead' : ''} ${isMax ? 'is-max' : ''}`} style={kind === 'mine' ? { '--sync-wave-duration': `${scanDuration}s` } : undefined} viewBox="0 0 300 76" role="img" aria-label={kind === 'mine' ? `HEARTBEAT.EXE heartbeat ${bpm} BPM` : 'Your tap heartbeat'}>
    {isMax && <defs><linearGradient id="sync-heart-rainbow" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="300" y2="0">
      <stop offset="0%" stopColor="#ff0000" /><stop offset="16%" stopColor="#ff9900" /><stop offset="32%" stopColor="#ffff00" />
      <stop offset="48%" stopColor="#33ff00" /><stop offset="64%" stopColor="#00ccff" /><stop offset="80%" stopColor="#6633ff" />
      <stop offset="100%" stopColor="#ff0000" /><animateTransform attributeName="gradientTransform" type="translate" from="-300 0" to="0 0" dur=".42s" repeatCount="indefinite" />
    </linearGradient></defs>}
    {kind === 'mine'
      ? <path className="sync-system-wave" d={dead ? 'M0 39 H300' : 'M0 39 H32 L43 34 L52 39 H72 L81 16 L89 61 L98 39 H132 L144 31 L152 39 H176 L186 18 L194 60 L203 39 H235 L246 33 L255 39 H300'} />
      : <path className="sync-user-wave" d={userPath} />}
  </svg>
}

function SyncWindowBar({ sequence, shuttingDown }) {
  return <header className="window-bar sync-window-bar">
    <BootSection active={sequence.isActive('title')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'title'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('title')} className="window-title"><div><strong>SYNC.EXE</strong><span>/SYNC</span></div></BootSection>
    <InstantBootSection active={sequence.isActive('back')} onActivated={sequence.startNext} shuttingDown={sequence.shutdownKey === 'back'} onShutdown={() => sequence.advanceInstantShutdown('back')} className="sync-back-boot"><button type="button" onClick={sequence.beginShutdown} disabled={!sequence.isBootComplete || shuttingDown}>[ BACK ]</button></InstantBootSection>
  </header>
}

function syncPhrase({ bpm, sync }) {
  if (bpm === 0) return 'I HAVE NO HEARTBEAT TO MATCH.'
  if (sync === null) return 'TAP TO MATCH MY HEART.'
  if (bpm === MAX_HEARTBEAT_BPM && sync < 40) return 'YOU ARE MADE OF MEAT. THIS WAS NEVER FAIR.'
  if (sync < 20) return 'YOU CANNOT KEEP UP.'
  if (sync < 40) return 'WE ARE NOT EVEN CLOSE.'
  if (sync < 60) return 'I CAN FEEL YOU TRYING.'
  if (sync < 80) return 'ALMOST SYNCHRONIZED.'
  if (sync < 95) return 'CLOSE.'
  if (sync < 100) return 'ALMOST ONE HEARTBEAT.'
  return 'SYNCHRONIZED.'
}

export function SyncPage() {
  const status = useHeartbeatStatus()
  const target = getHeartbeat(status.holderCount, status.balanceUsd)
  const [tapTimes, setTapTimes] = useState([])
  const [userBpm, setUserBpm] = useState(null)
  const [bestSync, setBestSync] = useState(null)
  const [displayNow, setDisplayNow] = useState(() => performance.now())
  const [tapFlash, setTapFlash] = useState(false)
  const [achievement, setAchievement] = useState(false)
  const tapsRef = useRef([])
  const inactivityTimerRef = useRef(null)
  const flashTimerRef = useRef(null)
  const achievementTimerRef = useRef(null)
  const lastAchievementTapCount = useRef(0)
  const navigateHome = useCallback(() => navigate('/'), [])
  const sequence = useSubsystemSequence(SYNC_BOOT_ORDER, navigateHome)
  const shuttingDown = sequence.shutdownKey !== null || sequence.frameShuttingDown
  const inputEnabled = sequence.isBootComplete && !shuttingDown
  const intervalCount = Math.max(0, tapTimes.length - 1)
  const sync = userBpm !== null && target.bpm > 0
    ? Math.round((Math.min(userBpm, target.bpm) / Math.max(userBpm, target.bpm)) * 100)
    : null

  useEffect(() => () => {
    window.clearTimeout(inactivityTimerRef.current)
    window.clearTimeout(flashTimerRef.current)
    window.clearTimeout(achievementTimerRef.current)
  }, [])

  useEffect(() => {
    if (!tapTimes.length) return undefined
    const timer = window.setInterval(() => setDisplayNow(performance.now()), 90)
    return () => window.clearInterval(timer)
  }, [tapTimes.length])

  useEffect(() => {
    if (sync !== null) setBestSync((current) => current === null ? sync : Math.max(current, sync))
  }, [sync])

  useEffect(() => {
    if (sync === null || sync < 98 || intervalCount < 5 || tapTimes.length === lastAchievementTapCount.current) return
    lastAchievementTapCount.current = tapTimes.length
    setAchievement(true)
    window.clearTimeout(achievementTimerRef.current)
    achievementTimerRef.current = window.setTimeout(() => setAchievement(false), 560)
  }, [intervalCount, sync, tapTimes.length])

  const resetTaps = useCallback(() => {
    tapsRef.current = []
    setTapTimes([])
    setUserBpm(null)
    setAchievement(false)
    lastAchievementTapCount.current = 0
  }, [])

  const registerTap = useCallback(() => {
    if (!inputEnabled) return
    const now = performance.now()
    const previous = tapsRef.current.at(-1)
    if (previous !== undefined && now - previous <= MIN_TAP_INTERVAL_MS) return
    const next = [...tapsRef.current, now].filter((tap) => now - tap <= PULSE_WINDOW_MS)
    tapsRef.current = next
    setTapTimes(next)
    setDisplayNow(now)
    if (next.length >= 3) {
      const intervals = next.slice(1).map((tap, index) => tap - next[index]).slice(-8)
      setUserBpm(Math.round(60_000 / median(intervals)))
    } else setUserBpm(null)

    setTapFlash(true)
    window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setTapFlash(false), 90)
    window.clearTimeout(inactivityTimerRef.current)
    inactivityTimerRef.current = window.setTimeout(resetTaps, INACTIVITY_MS)
  }, [inputEnabled, resetTaps])

  useEffect(() => {
    const onKeyDown = (event) => {
      const targetElement = event.target
      const inTextEntry = targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement || targetElement?.isContentEditable
      if (event.code !== 'Space' || event.repeat || inTextEntry || !inputEnabled) return
      event.preventDefault()
      registerTap()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [inputEnabled, registerTap])

  const phrase = achievement ? 'SYNCHRONIZATION ACHIEVED.' : syncPhrase({ bpm: target.bpm, sync })

  return <main className="page-shell sync-page-shell">
    <div className="machine-frame sync-machine-frame">
      <BootSection active={sequence.frameActive} onFirstOff={sequence.startNext} shuttingDown={sequence.frameShuttingDown} onShutdownComplete={sequence.finishFrame} className="frame-boot"><div className="frame-shell" /></BootSection>
      <div className={`machine-contents sync-machine-contents ${sequence.internalsLive ? 'internals-live' : ''}`}>
        <SyncWindowBar sequence={sequence} shuttingDown={shuttingDown} />
        <section className={`sync-module ${achievement ? 'sync-achieved' : ''}`} aria-label="Heartbeat synchronization game">
          <BootSection active={sequence.isActive('myHeart')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'myHeart'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('myHeart')} className="sync-section-boot">
            <section className="sync-heart-panel"><PanelHeader>MY HEART</PanelHeader><div className="sync-heart-body"><SyncWave kind="mine" bpm={target.bpm} /><div className="sync-metric"><span>MY BPM</span><i /><strong>{target.bpm}</strong></div></div></section>
          </BootSection>
          <BootSection active={sequence.isActive('yourHeart')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'yourHeart'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('yourHeart')} className="sync-section-boot">
            <section className="sync-heart-panel"><PanelHeader>YOUR HEART</PanelHeader><div className="sync-heart-body"><SyncWave kind="yours" taps={tapTimes} now={displayNow} /><div className="sync-metric"><span>YOUR BPM</span><i /><strong>{userBpm ?? '---'}</strong></div></div></section>
          </BootSection>
          <BootSection active={sequence.isActive('comparison')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'comparison'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('comparison')} className="sync-section-boot">
            <section className="sync-comparison-panel"><div className="sync-metric"><span>SYNC</span><i /><strong>{target.bpm === 0 ? 'IMPOSSIBLE' : sync === null ? '---' : `${sync}%`}</strong></div><div className="sync-metric"><span>BEST SYNC</span><i /><strong>{bestSync === null ? '---' : `${bestSync}%`}</strong></div></section>
          </BootSection>
          <InstantBootSection active={sequence.isActive('tap')} onActivated={sequence.startNext} shuttingDown={sequence.shutdownKey === 'tap'} onShutdown={() => sequence.advanceInstantShutdown('tap')} className="sync-tap-boot">
            <button type="button" className={`sync-tap ${tapFlash ? 'is-tapped' : ''}`} disabled={!inputEnabled} onPointerDown={(event) => { event.preventDefault(); registerTap() }}>TAP</button>
          </InstantBootSection>
          <BootSection active={sequence.isActive('result')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'result'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('result')} className="sync-result-boot">
            <p className="sync-result">{phrase}</p><p className="sync-hint">SPACEBAR ALSO WORKS</p>
          </BootSection>
        </section>
      </div>
    </div>
  </main>
}
