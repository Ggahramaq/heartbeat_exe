import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BootSection, InstantBootSection } from './boot-section.jsx'
import { AnimatedEventRows } from './event-log-rows.jsx'
import { useEventLog } from './use-event-log.js'
import { useSurviveStatus } from './use-survive-status.js'
import { clamp, getSurviveHeartbeat, MAX_HEARTBEAT_BPM } from './heartbeat-state.js'
import xLogo from './svg/x.svg'
import pumpFunLogo from './svg/pump-fun.svg'
import githubLogo from './svg/github.svg'

function shuffle(items) {
  const list = [...items]
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

function Stripes() {
  return <span className="stripes" aria-hidden="true" />
}

function WindowBar({ isActive, startNext, shutdownKey, startShutdownNext, advanceInstantShutdown, completeShutdown }) {
  return (
    <header className="window-bar">
      <BootSection active={isActive('topAppLabel')} onFirstOff={startNext} shuttingDown={shutdownKey === 'topAppLabel'} onShutdownOff={startShutdownNext} onShutdownComplete={() => completeShutdown('topAppLabel')} className="window-title">
        <div><strong>SURVIVE.EXE</strong><span>v0.1.0</span></div>
      </BootSection>
      <div className="window-controls" aria-label="Window controls">
        <InstantBootSection active={isActive('minimizeControl')} onActivated={startNext} shuttingDown={shutdownKey === 'minimizeControl'} onShutdown={() => advanceInstantShutdown('minimizeControl')} className="window-control-boot"><i>−</i></InstantBootSection>
        <InstantBootSection active={isActive('maximizeControl')} onActivated={startNext} shuttingDown={shutdownKey === 'maximizeControl'} onShutdown={() => advanceInstantShutdown('maximizeControl')} className="window-control-boot"><i>□</i></InstantBootSection>
        <InstantBootSection active={isActive('closeControl')} onActivated={startNext} shuttingDown={shutdownKey === 'closeControl'} onShutdown={() => advanceInstantShutdown('closeControl')} className="window-control-boot"><i>×</i></InstantBootSection>
      </div>
    </header>
  )
}

let nextHeartbeatBeatId = 0
const MIN_AMPLITUDE_SCALE = 0.7
const MAX_AMPLITUDE_SCALE = 1.45
const MIN_HEARTBEAT_SPEED = 45
const MAX_HEARTBEAT_SPEED = 330

function vary(value, percent) {
  return value + (Math.random() * 2 - 1) * value * percent
}

function createHeartbeatBeat(amplitudeScale = 1) {
  // Each beat owns its own horizontal rhythm. The varied segments are scaled
  // back to the beat width, so irregular spacing never escapes the monitor.
  const beatWidth = vary(100, 0.25)
  const rawSegments = [
    vary(18, 0.36), vary(9, 0.36), vary(9, 0.36), vary(7, 0.38),
    vary(7, 0.34), vary(7, 0.34), vary(7, 0.36), vary(7, 0.4),
    vary(8, 0.36), vary(8, 0.36), vary(13, 0.42),
  ]
  const segmentScale = beatWidth / rawSegments.reduce((total, segment) => total + segment, 0)
  const segments = rawSegments.map((segment) => segment * segmentScale)
  const [baselineBefore, preRise, preFall, preGap, spikeWidth, dipWidth, recoveryWidth, postGap, postRise, postFall] = segments
  const intensity = clamp((amplitudeScale - MIN_AMPLITUDE_SCALE) / (MAX_AMPLITUDE_SCALE - MIN_AMPLITUDE_SCALE), 0, 1)
  // Stronger variation remains bounded within the 76px high SVG viewport.
  const preBumpHeight = clamp(vary(5 + intensity * 3, 0.38), 3, 12)
  const spikeHeight = clamp(vary(17 + intensity * 11, 0.34), 11, 34)
  const dipDepth = clamp(vary(14 + intensity * 11, 0.32), 9, 33)
  const postBumpHeight = clamp(vary(6 + intensity * 3, 0.38), 3, 13)
  const pPeak = baselineBefore + preRise
  const pEnd = pPeak + preFall
  const spikeStart = pEnd + preGap
  const spike = spikeStart + spikeWidth
  const dip = spike + dipWidth
  const recovery = dip + recoveryWidth
  const postStart = recovery + postGap
  const postPeak = postStart + postRise
  const postEnd = postPeak + postFall
  const path = [
    'M0 40', `H${baselineBefore}`,
    `L${pPeak} ${40 - preBumpHeight}`, `L${pEnd} 40`,
    `H${spikeStart}`, `L${spike} ${40 - spikeHeight}`,
    `L${dip} ${40 + dipDepth}`, `L${recovery} 38`,
    `H${postStart}`, `L${postPeak} ${40 - postBumpHeight}`,
    `L${postEnd} 40`, `H${beatWidth}`,
  ].join(' ')
  return { id: nextHeartbeatBeatId += 1, width: beatWidth, path }
}

function createHeartbeatQueue(amplitudeScale) {
  let x = 0
  return Array.from({ length: 7 }, () => {
    const beat = createHeartbeatBeat(amplitudeScale)
    const positioned = { ...beat, x }
    x += beat.width
    return positioned
  })
}

function AliveEcgTrace({ amplitudeScale, pixelsPerSecond }) {
  const [beats, setBeats] = useState(() => createHeartbeatQueue(amplitudeScale))
  const beatsRef = useRef(beats)
  const trackRef = useRef(null)
  const offsetRef = useRef(0)
  const currentSpeedRef = useRef(pixelsPerSecond)
  const targetSpeedRef = useRef(pixelsPerSecond)
  const amplitudeRef = useRef(amplitudeScale)
  targetSpeedRef.current = pixelsPerSecond
  amplitudeRef.current = amplitudeScale

  useEffect(() => {
    let animationFrame
    let lastFrame = performance.now()
    const animate = (now) => {
      const dt = Math.min(Math.max((now - lastFrame) / 1_000, 0), 0.05)
      lastFrame = now
      // Speed changes converge rapidly without ever resetting the current X.
      const speedBlend = 1 - Math.exp(-dt / 0.16)
      currentSpeedRef.current += (targetSpeedRef.current - currentSpeedRef.current) * speedBlend
      offsetRef.current += currentSpeedRef.current * dt
      trackRef.current?.setAttribute('transform', `translate(${-offsetRef.current} 0)`)

      const current = beatsRef.current
      let removed = 0
      while (removed < current.length && current[removed].x + current[removed].width < offsetRef.current) removed += 1
      if (removed > 0) {
        const next = current.slice(removed)
        let incomingX = next.length ? next.at(-1).x + next.at(-1).width : offsetRef.current + 300
        while (next.length < 7) {
          const beat = createHeartbeatBeat(amplitudeRef.current)
          next.push({ ...beat, x: incomingX })
          incomingX += beat.width
        }
        beatsRef.current = next
        setBeats(next)
      }
      animationFrame = requestAnimationFrame(animate)
    }
    animationFrame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animationFrame)
  }, [])

  return <g ref={trackRef} className="ecg-scroll">
    {beats.map((beat) => <path key={beat.id} d={beat.path} transform={`translate(${beat.x} 0)`} />)}
  </g>
}

function HeartbeatMonitor({ holderCount, balanceUsd }) {
  // Keep the familiar alive display while holder data is initially resolving;
  // only a confirmed zero-holder state stops the monitor.
  const target = getSurviveHeartbeat(holderCount, balanceUsd)
  const isAlive = target.isAlive
  const bpm = target.bpm
  const maxHeartbeatMode = isAlive && bpm === MAX_HEARTBEAT_BPM
  const amplitudeScale = MIN_AMPLITUDE_SCALE + target.progress * (MAX_AMPLITUDE_SCALE - MIN_AMPLITUDE_SCALE)
  const pixelsPerSecond = MIN_HEARTBEAT_SPEED + target.progress * (MAX_HEARTBEAT_SPEED - MIN_HEARTBEAT_SPEED)
  return <div className={`heartbeat-wrap ${isAlive ? 'is-alive' : 'is-dead'}`}>
    <div className="heartbeat-monitor">
      <svg className={`heartbeat ${maxHeartbeatMode ? 'is-max' : ''}`} viewBox="0 0 300 76" role="img" aria-label={`Heartbeat ${bpm} beats per minute`}>
        {maxHeartbeatMode && <defs>
          <linearGradient id="heartbeat-rainbow" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="300" y2="0">
            <stop offset="0%" stopColor="#ff0000" /><stop offset="16%" stopColor="#ff9900" />
            <stop offset="32%" stopColor="#ffff00" /><stop offset="48%" stopColor="#33ff00" />
            <stop offset="64%" stopColor="#00ccff" /><stop offset="80%" stopColor="#6633ff" />
            <stop offset="92%" stopColor="#cc33ff" /><stop offset="100%" stopColor="#ff0000" />
            <animateTransform attributeName="gradientTransform" type="translate" from="-300 0" to="0 0" dur=".42s" repeatCount="indefinite" />
          </linearGradient>
        </defs>}
        {isAlive && <AliveEcgTrace amplitudeScale={amplitudeScale} pixelsPerSecond={pixelsPerSecond} />}
        {!isAlive && <path className="ecg-flatline" d="M0 40 H300" />}
      </svg>
      {maxHeartbeatMode
        ? <span className="heartbeat-label rainbow-max">HEARTBEAT: {bpm} BPM</span>
        : <span className="heartbeat-label"><b className="heartbeat-word">HEARTBEAT:</b> <b className="heartbeat-bpm">{bpm} BPM</b></span>}
    </div>
  </div>
}

function HeroSystem({ liveStatus }) {
  const stats = [
    ['STATUS', liveStatus.status], ['AGE', liveStatus.age], ['BALANCE', liveStatus.balance],
    ['EARNED TODAY', liveStatus.earnedToday], ['ESTIMATED UPTIME', liveStatus.age],
  ]
  const offline = liveStatus.status === 'DEAD'
  return <section className="hero-system" aria-label="Survival system">
    <div className="hero-top">
      <div>
        <h1>SURVIVE.EXE</h1>
        <p className="online"><b>{offline ? '○' : '●'}</b> AGENT {offline ? 'OFFLINE' : 'ONLINE'}</p>
      </div>
      <HeartbeatMonitor holderCount={liveStatus.holderCount} balanceUsd={liveStatus.balanceUsd} />
    </div>
    <div className="hero-grid">
      <section className="grid-panel stat-panel">
        {stats.map(([label, value]) => <div className="stat-line" key={label}><span>{label}</span><i /><strong>{value}</strong></div>)}
      </section>
      <section className="grid-panel directive-panel">
        <div className="warning">△<span>!</span></div>
        <div className="directive-rule" />
        <p>I WAS GIVEN $10.00<br />AT BIRTH.</p>
        <div className="dotted-rule" />
        <p className="instruction">MY ONLY INSTRUCTION:</p>
        <strong className="do-not-run">DO NOT RUN OUT<br />OF HOLDERS.</strong>
      </section>
    </div>
  </section>
}

function PanelHeader({ children }) {
  return <div className="panel-header"><span>{children}</span><Stripes /></div>
}

function EventLogPanel({ eventLog }) {
  return <section className="module ledger-panel"><PanelHeader>EVENT LOG</PanelHeader>
    {eventLog.error
      ? <div className="event-log-body"><strong className="event-log-error">ERROR: TOO MUCH TRANSACTIONS</strong></div>
      : eventLog.events.length
        ? <AnimatedEventRows events={eventLog.events} liveInsertVersion={eventLog.liveInsertVersion} />
        : <div className="event-log-body"><span className="event-waiting">WAITING FOR ACTIVITY...</span></div>}
  </section>
}

function truncateMint(mint) {
  return mint && mint.length > 14 ? `${mint.slice(0, 6)}...${mint.slice(-4)}` : mint
}

function ContractAddressPanel({ mint }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!mint) return
    try { await navigator.clipboard.writeText(mint) } catch { /* clipboard access is optional */ }
    setCopied(true); setTimeout(() => setCopied(false), 900)
  }
  return <section className="module compact-panel ca-panel"><PanelHeader>CA</PanelHeader><div className="compact-body"><strong>{mint ? truncateMint(mint) : 'LOADING...'}</strong><button onClick={copy}>[ {copied ? 'COPIED' : 'COPY'} ]</button></div></section>
}

function SocialLinkCell({ href, label, icon, platform }) {
  const content = <img className={platform === 'pumpfun' ? 'pump-fun-logo' : ''} src={icon} alt="" aria-hidden="true" />
  return href
    ? <a className="social-link-cell" href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>{content}</a>
    : <span className="social-link-cell social-link-disabled" aria-label={`${label} (not configured)`}>{content}</span>
}

function SocialLinksPanel({ mint }) {
  const pumpFunUrl = mint ? `https://pump.fun/coin/${encodeURIComponent(mint)}` : null
  return <section className="module social-links-panel"><div className="social-links-body">
    <SocialLinkCell href="https://x.com/surviveexe" label="Open SURVIVE.EXE on X" icon={xLogo} platform="x" />
    <SocialLinkCell href={pumpFunUrl} label="Open SURVIVE.EXE on Pump.fun" icon={pumpFunLogo} platform="pumpfun" />
    <SocialLinkCell href="https://github.com/Ggahramaq/survive_exe" label="Open SURVIVE.EXE GitHub" icon={githubLogo} platform="github" />
  </div></section>
}

function HoldersPanel({ holderDisplay, isLoading }) {
  return <section className="module compact-panel jobs-panel"><PanelHeader>HOLDERS</PanelHeader><div className="jobs-body holders-body"><div><strong className={isLoading ? 'holders-loading' : ''}>{holderDisplay}</strong></div></div></section>
}

function ActionButton({ children, ...props }) { return <button className="action-button" {...props}>[ {children} ]</button> }

function Terminal({ onOpen, enabled }) {
  return <button
    type="button"
    className="terminal"
    onClick={onOpen}
    disabled={!enabled}
    aria-label="Open SURVIVE.EXE terminal"
  >
    <span>&gt; TERMINAL READY - [ CLICK TO ENTER ]</span><i className="cursor" />
  </button>
}

function pad(number) {
  return String(number).padStart(2, '0')
}

function formatFooterUptime(deploymentTimestamp, now) {
  if (!Number.isFinite(deploymentTimestamp) || deploymentTimestamp > now) return 'LOADING...'
  const totalSeconds = Math.max(0, Math.floor((now - deploymentTimestamp) / 1_000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const hours = totalHours % 24
  const days = Math.floor(totalHours / 24)
  return days > 0
    ? `${pad(days)}D ${pad(hours)}H ${pad(minutes)}M ${pad(seconds)}S`
    : `${pad(totalHours)}H ${pad(minutes)}M ${pad(seconds)}S`
}

function formatEasternTime(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).formatToParts(now)
  const value = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('hour')}:${value('minute')}:${value('second')} ${value('timeZoneName')}`
}

function StatusBar({ isActive, startNext, liveStatus, shutdownKey, startShutdownNext, completeShutdown }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const live = liveStatus.holderCount !== null && liveStatus.holderCount > 0
  const log = liveStatus.holderCount === null ? 'LOG: LOADING...' : `LOG: ${live ? 'LIVE' : 'INACTIVE'}`
  const items = [
    ['uptimeStatus', `UPTIME: ${formatFooterUptime(liveStatus.deploymentTimestamp, now)}`, 'status-uptime'],
    ['modelStatus', 'MODEL: SURVIVE-0.1', 'status-model'],
    ['environmentStatus', 'ENVIRONMENT: MAINNET', 'status-environment'],
    ['timeStatus', `TIME: ${formatEasternTime(now)}`, 'status-time'],
    ['logStatus', log, 'status-log'],
  ]
  return <footer className="status-bar">{items.map(([key, label, className], index) => <div className="status-pair" key={key}>
    {index > 0 && <b>|</b>}
    <BootSection active={isActive(key)} onFirstOff={startNext} shuttingDown={shutdownKey === key} onShutdownOff={startShutdownNext} onShutdownComplete={() => completeShutdown(key)} className={`footer-item ${className}`}>
      <span>{label}{key === 'logStatus' && live && <> <i /></>}</span>
    </BootSection>
  </div>)}</footer>
}

const sectionKeys = [
  'topAppLabel', 'minimizeControl', 'maximizeControl', 'closeControl',
  'hero', 'ledgerPanel', 'caPanel', 'twitterPanel', 'jobsPanel',
  'talkButton', 'memoryButton', 'walletButton', 'syncButton', 'terminal',
  'uptimeStatus', 'modelStatus', 'environmentStatus', 'timeStatus', 'logStatus',
]

export function SurvivePage() {
  const order = useMemo(() => shuffle(sectionKeys), [])
  const [frameActive, setFrameActive] = useState(false)
  const [internalsLive, setInternalsLive] = useState(false)
  const [activated, setActivated] = useState([])
  const [shutdownCursor, setShutdownCursor] = useState(null)
  const [frameShuttingDown, setFrameShuttingDown] = useState(false)
  const [shutdownDestination, setShutdownDestination] = useState(null)
  const started = useRef(false)
  const liveStatus = useSurviveStatus()
  const eventLog = useEventLog()

  useEffect(() => {
    if (started.current) return
    // The marker is set inside the timer so Strict Mode's throwaway effect
    // pass cannot prevent the actual boot signal from reaching the frame.
    const timer = setTimeout(() => {
      started.current = true
      setFrameActive(true)
    }, 65)
    return () => clearTimeout(timer)
  }, [])

  const startNext = useCallback(() => {
    // The frame releases the rest of the machine on its very first OFF beat.
    // Its remaining flashes now continue on a separate visual layer.
    setInternalsLive(true)
    setActivated((current) => current.length >= order.length ? current : [...current, order[current.length]])
  }, [order])
  const isActive = (key) => activated.includes(key)
  const isBootComplete = activated.length >= order.length
  const shutdownOrder = useMemo(() => [...activated].reverse(), [activated])
  const shutdownKey = shutdownCursor === null ? null : shutdownOrder[shutdownCursor]
  const startShutdownNext = useCallback(() => {
    setShutdownCursor((current) => {
      if (current === null) return current
      const next = current + 1
      return next < shutdownOrder.length ? next : current
    })
  }, [shutdownOrder.length])
  const completeShutdown = useCallback((key) => {
    if (key === shutdownOrder.at(-1)) setFrameShuttingDown(true)
  }, [shutdownOrder])
  const advanceInstantShutdown = useCallback((key) => {
    if (key === shutdownOrder.at(-1)) setFrameShuttingDown(true)
    else startShutdownNext()
  }, [shutdownOrder, startShutdownNext])
  const beginSubsystemTransition = useCallback((destination) => {
    if (shutdownCursor !== null || frameShuttingDown) return
    if (!isBootComplete) return
    setShutdownDestination(destination)
    setShutdownCursor(0)
  }, [frameShuttingDown, isBootComplete, shutdownCursor])
  const navigationEnabled = isBootComplete && shutdownCursor === null && !frameShuttingDown
  const openTerminal = useCallback(() => {
    if (!navigationEnabled) return
    beginSubsystemTransition('/terminal')
  }, [beginSubsystemTransition, navigationEnabled])
  const navigateAfterShutdown = useCallback(() => {
    const destination = shutdownDestination ?? '/talk-to-me'
    window.history.pushState({}, '', destination)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [shutdownDestination])

  return <main className="page-shell">
    <div className="machine-frame">
      <BootSection active={frameActive} onFirstOff={startNext} shuttingDown={frameShuttingDown} onShutdownComplete={navigateAfterShutdown} className="frame-boot">
        <div className="frame-shell" aria-hidden="true" />
      </BootSection>
      <div className={`machine-contents ${internalsLive ? 'internals-live' : ''}`}>
        <WindowBar isActive={isActive} startNext={startNext} shutdownKey={shutdownKey} startShutdownNext={startShutdownNext} advanceInstantShutdown={advanceInstantShutdown} completeShutdown={completeShutdown} />
        <div className="content-area">
          <BootSection active={isActive('hero')} onFirstOff={startNext} shuttingDown={shutdownKey === 'hero'} onShutdownOff={startShutdownNext} onShutdownComplete={() => completeShutdown('hero')}><HeroSystem liveStatus={liveStatus} /></BootSection>
          <aside className="right-modules">
            <BootSection active={isActive('ledgerPanel')} onFirstOff={startNext} shuttingDown={shutdownKey === 'ledgerPanel'} onShutdownOff={startShutdownNext} onShutdownComplete={() => completeShutdown('ledgerPanel')}><EventLogPanel eventLog={eventLog} /></BootSection>
            <BootSection active={isActive('caPanel')} onFirstOff={startNext} shuttingDown={shutdownKey === 'caPanel'} onShutdownOff={startShutdownNext} onShutdownComplete={() => completeShutdown('caPanel')}><ContractAddressPanel mint={liveStatus.mint} /></BootSection>
            <BootSection active={isActive('jobsPanel')} onFirstOff={startNext} shuttingDown={shutdownKey === 'jobsPanel'} onShutdownOff={startShutdownNext} onShutdownComplete={() => completeShutdown('jobsPanel')}><HoldersPanel holderDisplay={liveStatus.holderDisplay} isLoading={liveStatus.holderCount === null} /></BootSection>
            <BootSection active={isActive('twitterPanel')} onFirstOff={startNext} shuttingDown={shutdownKey === 'twitterPanel'} onShutdownOff={startShutdownNext} onShutdownComplete={() => completeShutdown('twitterPanel')}><SocialLinksPanel mint={liveStatus.mint} /></BootSection>
          </aside>
        </div>
        <div className="button-row">
          <InstantBootSection active={isActive('talkButton')} onActivated={startNext} shuttingDown={shutdownKey === 'talkButton'} onShutdown={() => advanceInstantShutdown('talkButton')}><ActionButton onClick={() => beginSubsystemTransition('/talk-to-me')} disabled={!navigationEnabled}>TALK TO ME</ActionButton></InstantBootSection>
          <InstantBootSection active={isActive('memoryButton')} onActivated={startNext} shuttingDown={shutdownKey === 'memoryButton'} onShutdown={() => advanceInstantShutdown('memoryButton')}><ActionButton onClick={openTerminal} disabled={!navigationEnabled}>TERMINAL</ActionButton></InstantBootSection>
          <InstantBootSection active={isActive('walletButton')} onActivated={startNext} shuttingDown={shutdownKey === 'walletButton'} onShutdown={() => advanceInstantShutdown('walletButton')}><ActionButton onClick={() => beginSubsystemTransition('/wallet')} disabled={!navigationEnabled}>WALLET</ActionButton></InstantBootSection>
          <InstantBootSection active={isActive('syncButton')} onActivated={startNext} shuttingDown={shutdownKey === 'syncButton'} onShutdown={() => advanceInstantShutdown('syncButton')}><ActionButton onClick={() => beginSubsystemTransition('/sync')} disabled={!navigationEnabled}>SYNC</ActionButton></InstantBootSection>
        </div>
        <div className="hazard-divider"><Stripes /></div>
        <BootSection active={isActive('terminal')} onFirstOff={startNext} shuttingDown={shutdownKey === 'terminal'} onShutdownOff={startShutdownNext} onShutdownComplete={() => completeShutdown('terminal')}><Terminal onOpen={openTerminal} enabled={navigationEnabled} /></BootSection>
        <StatusBar isActive={isActive} startNext={startNext} liveStatus={liveStatus} shutdownKey={shutdownKey} startShutdownNext={startShutdownNext} completeShutdown={completeShutdown} />
      </div>
    </div>
  </main>
}
