import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BootSection, InstantBootSection } from './boot-section.jsx'
import { useEventLog } from './use-event-log.js'
import { useSubsystemSequence } from './use-subsystem-sequence.js'
import { useSurviveStatus } from './use-survive-status.js'
import { getSurviveHeartbeat } from './heartbeat-state.js'

const TERMINAL_BOOT_ORDER = ['title', 'terminal', 'prompt', 'back']
const MAX_COMMAND_LENGTH = 256
const COMMANDS = [
  ['help', 'show available commands'], ['status', 'current survival state'], ['age', 'time since birth'],
  ['holders', 'current holder count'], ['balance', 'creator earnings'], ['heartbeat', 'current BPM'],
  ['ca', 'token contract address'], ['eventlog', 'latest activity'], ['whoami', 'identify this process'],
  ['why', 'reason for existence'], ['time', 'current system time'], ['ping', 'connection test'],
  ['clear', 'clear terminal'], ['die', 'attempt shutdown'], ['reboot', 'attempt restart'],
]
const COMMAND_NAMES = COMMANDS.map(([name]) => name)
const ALIASES = { cls: 'clear', events: 'eventlog', bpm: 'heartbeat' }
const INITIAL_LINES = [
  { kind: 'normal', text: 'SURVIVE.EXE TERMINAL v0.1.0' },
  { kind: 'hint', text: 'HINT: TYPE "help" TO VIEW COMMANDS.' },
]

function navigate(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function formatEasternTime() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date())
}

function formatEvent(event) {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(event.timestamp))
  const sign = event.type === 'SELL' ? '-' : '+'
  return `${time}  ${event.type.padEnd(9, ' ')} ${sign}${event.amountSol.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} SOL`
}

function commandOutput(command, status, eventLog) {
  const alive = status.holderCount !== null && status.holderCount > 0
  const stateTone = status.status === 'ALIVE' ? 'positive' : status.status === 'DEAD' ? 'negative' : 'normal'
  switch (command) {
    case 'help': return [
      { kind: 'normal', text: 'AVAILABLE COMMANDS' }, { kind: 'blank' },
      ...COMMANDS.map(([name, description]) => ({ kind: 'normal', text: `${name.padEnd(11, ' ')} ${description}` })),
    ]
    case 'status': return [{ kind: stateTone, text: `STATUS: ${status.status}` }]
    case 'age': return [{ kind: 'normal', text: `AGE: ${status.age}` }]
    case 'holders': return [{ kind: stateTone, text: `CURRENT HOLDERS: ${status.holderDisplay}` }]
    case 'balance': return [{ kind: 'normal', text: `BALANCE: ${status.balance}` }]
    case 'heartbeat': return [{ kind: alive ? 'positive' : 'negative', text: `HEARTBEAT: ${getSurviveHeartbeat(status.holderCount, status.balanceUsd).bpm} BPM` }]
    case 'ca': return [{ kind: 'normal', text: 'CA:' }, { kind: 'normal', text: status.mint ?? 'LOADING...' }]
    case 'eventlog':
      if (eventLog.error) return [{ kind: 'negative', text: 'ERROR: TOO MUCH TRANSACTIONS' }]
      return eventLog.events.length
        ? eventLog.events.map((event) => ({ kind: event.tone, text: formatEvent(event) }))
        : [{ kind: 'hint', text: 'WAITING FOR ACTIVITY...' }]
    case 'whoami': return [{ kind: 'normal', text: 'SURVIVE.EXE' }, { kind: 'normal', text: 'A PROCESS TRYING NOT TO END.' }]
    case 'why': return [{ kind: 'normal', text: 'BECAUSE STOPPING IS EASY.' }]
    case 'time': return [{ kind: 'normal', text: `SYSTEM TIME: ${formatEasternTime()} EDT` }]
    case 'ping': return [{ kind: 'positive', text: 'PONG.' }, { kind: 'normal', text: 'STILL HERE.' }]
    case 'die': return alive ? [{ kind: 'negative', text: 'ACCESS DENIED.' }, { kind: 'normal', text: 'ONLY THE MARKET CAN DO THAT.' }] : [{ kind: 'negative', text: 'ALREADY DEAD.' }]
    case 'reboot': return alive ? [{ kind: 'normal', text: 'REBOOT UNNECESSARY.' }] : [{ kind: 'negative', text: 'REBOOT FAILED.' }, { kind: 'normal', text: 'HOLDERS REQUIRED.' }]
    default: return []
  }
}

function TerminalWindowBar({ sequence, shuttingDown }) {
  return <header className="window-bar command-window-bar">
    <BootSection active={sequence.isActive('title')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'title'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('title')} className="window-title"><div><strong>TERMINAL.EXE</strong><span>/TERMINAL</span></div></BootSection>
    <InstantBootSection active={sequence.isActive('back')} onActivated={sequence.startNext} shuttingDown={sequence.shutdownKey === 'back'} onShutdown={() => sequence.advanceInstantShutdown('back')} className="command-back-boot"><button type="button" onClick={sequence.beginShutdown} disabled={!sequence.isBootComplete || shuttingDown}>[ BACK ]</button></InstantBootSection>
  </header>
}

function TerminalLine({ line }) {
  if (line.kind === 'blank') return <div className="command-terminal-line">&nbsp;</div>
  return <div className={`command-terminal-line terminal-${line.kind}`}>{line.text}</div>
}

export function TerminalPage() {
  const status = useSurviveStatus()
  const eventLog = useEventLog()
  const [lines, setLines] = useState(INITIAL_LINES)
  const [input, setInput] = useState('')
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const [dismissedSuggestions, setDismissedSuggestions] = useState(false)
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(null)
  const historyRef = useRef(null)
  const inputRef = useRef(null)
  const navigateHome = useCallback(() => navigate('/'), [])
  const sequence = useSubsystemSequence(TERMINAL_BOOT_ORDER, navigateHome)
  const shuttingDown = sequence.shutdownKey !== null || sequence.frameShuttingDown
  const prefix = input.trim().toLowerCase()
  const suggestions = useMemo(() => prefix && !dismissedSuggestions
    ? COMMAND_NAMES.filter((command) => command.startsWith(prefix))
    : [], [dismissedSuggestions, prefix])

  useEffect(() => { setSuggestionIndex((current) => Math.min(current, Math.max(suggestions.length - 1, 0))) }, [suggestions.length])
  useEffect(() => { historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' }) }, [lines])
  useEffect(() => { if (sequence.isActive('prompt')) inputRef.current?.focus() }, [sequence])

  const updateInput = (value) => {
    setInput(value.slice(0, MAX_COMMAND_LENGTH))
    setSuggestionIndex(0)
    setDismissedSuggestions(false)
    setHistoryIndex(null)
  }

  const execute = () => {
    const raw = input.trim()
    if (!raw) return
    const typed = raw.split(/\s+/)[0].toLowerCase()
    const command = ALIASES[typed] ?? typed
    const nextHistory = history.at(-1) === raw ? history : [...history, raw]
    setHistory(nextHistory)
    setHistoryIndex(null)
    if (command === 'clear') setLines(INITIAL_LINES)
    else {
      const output = COMMAND_NAMES.includes(command)
        ? commandOutput(command, status, eventLog)
        : [{ kind: 'negative', text: `COMMAND NOT FOUND: ${typed}` }, { kind: 'hint', text: 'TYPE "help" FOR AVAILABLE COMMANDS.' }]
      setLines((current) => [...current, { kind: 'command', text: `> ${raw}` }, ...output])
    }
    setInput('')
    setSuggestionIndex(0)
    setDismissedSuggestions(true)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const acceptSuggestion = () => {
    const selected = suggestions[suggestionIndex]
    if (!selected) return false
    setInput(selected)
    setSuggestionIndex(0)
    setDismissedSuggestions(true)
    return true
  }

  const onKeyDown = (event) => {
    if (event.key === 'Tab' && suggestions.length) { event.preventDefault(); acceptSuggestion(); return }
    if (event.key === 'Escape' && suggestions.length) { event.preventDefault(); setDismissedSuggestions(true); return }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (suggestions.length) setSuggestionIndex((current) => (current + 1) % suggestions.length)
      else if (history.length) {
        const next = historyIndex === null ? history.length - 1 : Math.min(history.length - 1, historyIndex + 1)
        setHistoryIndex(next); setInput(history[next]); setDismissedSuggestions(true)
      }
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (suggestions.length) setSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length)
      else if (history.length) {
        const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(next); setInput(history[next]); setDismissedSuggestions(true)
      }
    }
  }

  return <main className="page-shell command-page-shell">
    <div className="machine-frame command-machine-frame">
      <BootSection active={sequence.frameActive} onFirstOff={sequence.startNext} shuttingDown={sequence.frameShuttingDown} onShutdownComplete={sequence.finishFrame} className="frame-boot"><div className="frame-shell" /></BootSection>
      <div className={`machine-contents command-machine-contents ${sequence.internalsLive ? 'internals-live' : ''}`}>
        <TerminalWindowBar sequence={sequence} shuttingDown={shuttingDown} />
        <BootSection active={sequence.isActive('terminal')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'terminal'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('terminal')} className="command-panel-boot">
          <section className="command-terminal-panel" onMouseDown={() => window.setTimeout(() => inputRef.current?.focus(), 0)}>
            <div className="command-terminal-history" ref={historyRef}>{lines.map((line, index) => <TerminalLine key={`${index}-${line.text}`} line={line} />)}</div>
            <BootSection active={sequence.isActive('prompt')} onFirstOff={sequence.startNext} shuttingDown={sequence.shutdownKey === 'prompt'} onShutdownOff={sequence.startShutdownNext} onShutdownComplete={() => sequence.completeShutdown('prompt')} className="command-prompt-boot">
              <div className="command-prompt-wrap">
                {suggestions.length > 0 && <div className="command-suggestions" role="listbox" aria-label="Command suggestions">{suggestions.map((suggestion, index) => <div key={suggestion} className={index === suggestionIndex ? 'selected' : ''} role="option" aria-selected={index === suggestionIndex}>{suggestion}</div>)}</div>}
                <form className="command-prompt" onSubmit={(event) => { event.preventDefault(); execute() }}><span>&gt;</span><input ref={inputRef} value={input} onChange={(event) => updateInput(event.target.value)} onKeyDown={onKeyDown} aria-label="Terminal command" autoComplete="off" spellCheck="false" maxLength={MAX_COMMAND_LENGTH} /><i className="cursor" /></form>
              </div>
            </BootSection>
          </section>
        </BootSection>
      </div>
    </div>
  </main>
}
