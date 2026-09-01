import { useCallback, useState } from 'react'
import { BootSection, InstantBootSection } from './boot-section.jsx'
import { AnimatedEventRows } from './event-log-rows.jsx'
import { useEventLog } from './use-event-log.js'
import { useSubsystemSequence } from './use-subsystem-sequence.js'
import { useHeartbeatStatus } from './use-heartbeat-status.js'

const WALLET_BOOT_ORDER = ['title', 'eventLog', 'token', 'copy', 'view', 'terminal', 'back']

function navigate(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function PanelHeader({ children }) {
  return <div className="panel-header"><span>{children}</span><span className="stripes" /></div>
}

function shortenMint(mint) {
  return mint ? `${mint.slice(0, 6)}...${mint.slice(-4)}` : 'NOT CONFIGURED'
}

function LargeEventLog({ eventLog }) {
  return <section className="wallet-panel wallet-large-event-log">
    <PanelHeader>EVENT LOG</PanelHeader>
    {eventLog.error
      ? <div className="event-log-body"><strong className="event-log-error">ERROR: TOO MUCH LOGS</strong></div>
      : eventLog.events.length
        ? <AnimatedEventRows events={eventLog.events} liveInsertVersion={eventLog.liveInsertVersion} />
        : <div className="event-log-body"><span className="event-waiting">WAITING FOR ACTIVITY...</span></div>}
  </section>
}

export function WalletPage() {
  const eventLog = useEventLog()
  const status = useHeartbeatStatus()
  const mint = status.mint ?? null
  const [copied, setCopied] = useState(false)
  const navigateHome = useCallback(() => navigate('/'), [])
  const sequence = useSubsystemSequence(WALLET_BOOT_ORDER, navigateHome)
  const shuttingDown = sequence.shutdownKey !== null || sequence.frameShuttingDown
  const copyMint = useCallback(async () => {
    if (!mint) return
    try { await navigator.clipboard.writeText(mint) } catch { /* clipboard access is optional */ }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 900)
  }, [mint])
  const pumpUrl = mint ? `https://pump.fun/coin/${encodeURIComponent(mint)}` : null

  return <main className="page-shell wallet-page-shell">
    <div className="machine-frame wallet-machine-frame">
      <BootSection active={sequence.frameActive} onFirstOff={sequence.startNext} shuttingDown={sequence.frameShuttingDown} onShutdownComplete={sequence.finishFrame} className="frame-boot"><div className="frame-shell" /></BootSection>
      <div className={`machine-contents wallet-machine-contents ${sequence.internalsLive ? 'internals-live' : ''}`}>
        <header className="window-bar wallet-window-bar">
          <BootSection active={sequence.isActive('title')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'title'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('title')} className="window-title"><div><strong>WALLET.EXE</strong><span>/WALLET</span></div></BootSection>
          <InstantBootSection active={sequence.isActive('back')} onActivated={sequence.startNext} shuttingDown={sequence.shutdownKey === 'back'} onShutdown={() => sequence.advanceInstantShutdown('back')} className="wallet-back-boot"><button type="button" onClick={sequence.beginShutdown} disabled={!sequence.isBootComplete || shuttingDown}>[ BACK ]</button></InstantBootSection>
        </header>
        <div className="wallet-body">
          <BootSection active={sequence.isActive('eventLog')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'eventLog'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('eventLog')} className="wallet-event-log-boot"><LargeEventLog eventLog={eventLog} /></BootSection>
          <BootSection active={sequence.isActive('token')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'token'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('token')} className="wallet-token-boot">
            <section className="wallet-panel wallet-token-panel">
              <PanelHeader>TOKEN</PanelHeader>
              <div className="wallet-token-body"><div className="wallet-token-ca"><span>CA</span><i /><strong title={mint ?? undefined}>{shortenMint(mint)}</strong></div>
                <div className="wallet-token-actions">
                  <InstantBootSection active={sequence.isActive('copy')} onActivated={sequence.startNext} shuttingDown={sequence.shutdownKey === 'copy'} onShutdown={() => sequence.advanceInstantShutdown('copy')}><button type="button" disabled={!mint || shuttingDown} onClick={copyMint}>[ {copied ? 'COPIED' : 'COPY ADDRESS'} ]</button></InstantBootSection>
                  <InstantBootSection active={sequence.isActive('view')} onActivated={sequence.startNext} shuttingDown={sequence.shutdownKey === 'view'} onShutdown={() => sequence.advanceInstantShutdown('view')}>{pumpUrl ? <a href={pumpUrl} target="_blank" rel="noopener noreferrer">[ VIEW ONCHAIN ]</a> : <button type="button" disabled>[ VIEW ONCHAIN ]</button>}</InstantBootSection>
                </div>
              </div>
            </section>
          </BootSection>
          <BootSection active={sequence.isActive('terminal')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'terminal'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('terminal')} className="wallet-terminal-boot"><section className="wallet-terminal">&gt; <i className="cursor" /></section></BootSection>
        </div>
      </div>
    </div>
  </main>
}
