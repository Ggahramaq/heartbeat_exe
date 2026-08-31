import { useCallback, useEffect, useRef, useState } from 'react'
import { BootSection, InstantBootSection } from './boot-section.jsx'
import { useSubsystemSequence } from './use-subsystem-sequence.js'

const MAX_MESSAGE_LENGTH = 1_000
const TALK_BOOT_ORDER = ['title', 'chat', 'input', 'back']

function navigate(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function TalkWindowBar({ sequence, shuttingDown }) {
  return <header className="window-bar talk-window-bar">
    <BootSection active={sequence.isActive('title')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'title'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('title')} className="window-title"><div><strong>TALK_TO_ME.EXE</strong><span>/TALK</span></div></BootSection>
    <InstantBootSection active={sequence.isActive('back')} onActivated={sequence.startNext} shuttingDown={sequence.shutdownKey === 'back'} onShutdown={() => sequence.advanceInstantShutdown('back')} className="talk-back-boot"><button type="button" onClick={sequence.beginShutdown} disabled={!sequence.isBootComplete || shuttingDown}>[ BACK ]</button></InstantBootSection>
  </header>
}

function ChatLine({ message }) {
  return <div className={`talk-line talk-${message.sender}`}><b>{message.sender === 'user' ? 'YOU' : 'SURVIVE'}:</b><span>{message.text}</span></div>
}

export function TalkPage() {
  const [messages, setMessages] = useState([{ sender: 'assistant', text: 'you wanted to talk.' }])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const feedRef = useRef(null)
  const navigateHome = useCallback(() => navigate('/'), [])
  const sequence = useSubsystemSequence(TALK_BOOT_ORDER, navigateHome)
  const shuttingDown = sequence.shutdownKey !== null || sequence.frameShuttingDown

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }) }, [messages, thinking])

  const send = async () => {
    const text = input.trim()
    if (!text || thinking || text.length > MAX_MESSAGE_LENGTH) return
    const outgoing = { sender: 'user', text }
    const history = [...messages, outgoing]
    setMessages(history)
    setInput('')
    setThinking(true)
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: history.slice(-16) }) })
      const payload = await response.json().catch(() => null)
      setMessages((current) => [...current, { sender: 'assistant', text: typeof payload?.reply === 'string' ? payload.reply : 'connection lost.' }])
    } catch {
      setMessages((current) => [...current, { sender: 'assistant', text: 'connection lost.' }])
    } finally { setThinking(false) }
  }

  return <main className="page-shell talk-page-shell">
    <div className="machine-frame talk-machine-frame">
      <BootSection active={sequence.frameActive} onFirstOff={sequence.startNext} shuttingDown={sequence.frameShuttingDown} onShutdownComplete={sequence.finishFrame} className="frame-boot"><div className="frame-shell" /></BootSection>
      <div className={`machine-contents talk-machine-contents ${sequence.internalsLive ? 'internals-live' : ''}`}>
        <TalkWindowBar sequence={sequence} shuttingDown={shuttingDown} />
        <BootSection active={sequence.isActive('chat')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'chat'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('chat')} className="talk-chat-boot">
          <section className="talk-chat-module" aria-label="Talk to SURVIVE.EXE"><div className="panel-header"><span>TALK TO ME</span><span className="stripes" /></div><div className="talk-feed" ref={feedRef} aria-live="polite">
            {messages.map((message, index) => <ChatLine message={message} key={`${message.sender}-${index}-${message.text}`} />)}
            {thinking && <div className="talk-line talk-assistant"><b>SURVIVE:</b><span>PROCESSING... <i className="cursor" /></span></div>}
          </div></section>
        </BootSection>
        <BootSection active={sequence.isActive('input')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'input'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('input')} className="talk-input-boot">
          <form className="talk-input-row" onSubmit={(event) => { event.preventDefault(); void send() }}><label htmlFor="talk-input">&gt;</label><textarea id="talk-input" value={input} onChange={(event) => setInput(event.target.value.slice(0, MAX_MESSAGE_LENGTH))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} disabled={thinking} maxLength={MAX_MESSAGE_LENGTH} rows="1" placeholder="_" /><button type="submit" disabled={thinking || !input.trim()}>[ SEND ]</button></form>
        </BootSection>
      </div>
    </div>
  </main>
}
