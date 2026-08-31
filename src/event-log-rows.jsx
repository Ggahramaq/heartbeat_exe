import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const EVENT_ROW_TRANSITION_MS = 180

function formatEventTime(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(timestamp))
  const value = (type) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${value('hour')}:${value('minute')}:${value('second')}`
}

function formatEventAmount(event) {
  const prefix = event.type === 'SELL' ? '-' : '+'
  return `${prefix}${event.amountSol.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} SOL`
}

function EventRow({ event, className = '', rowRef, style }) {
  return <div ref={rowRef} className={`event-line event-${event.tone} ${className}`} style={style}>
    <span>{formatEventTime(event.timestamp)}</span><span>{event.type}</span><span>{formatEventAmount(event)}</span>
  </div>
}

/** Shared physical five-row transaction buffer used by the main and wallet Event Logs. */
export function AnimatedEventRows({ events, liveInsertVersion }) {
  const bodyRef = useRef(null)
  const rowRefs = useRef(new Map())
  const positionsRef = useRef(new Map())
  const previousEventsRef = useRef([])
  const lastLiveInsertRef = useRef(liveInsertVersion)
  const exitIdRef = useRef(0)
  const exitTimersRef = useRef(new Set())
  const [exiting, setExiting] = useState([])

  const setRowRef = useCallback((id, node) => {
    if (node) rowRefs.current.set(id, node)
    else rowRefs.current.delete(id)
  }, [])

  useEffect(() => () => {
    for (const timer of exitTimersRef.current) window.clearTimeout(timer)
    exitTimersRef.current.clear()
  }, [])

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const bodyRect = body.getBoundingClientRect()
    const nextPositions = new Map()
    for (const event of events) {
      const row = rowRefs.current.get(event.id)
      if (row) nextPositions.set(event.id, row.getBoundingClientRect())
    }
    const isLiveInsertion = liveInsertVersion > lastLiveInsertRef.current
    if (isLiveInsertion && nextPositions.size) {
      const orderedPositions = events.map((event) => nextPositions.get(event.id)).filter(Boolean)
      const rowStep = orderedPositions.length > 1
        ? orderedPositions[1].top - orderedPositions[0].top
        : orderedPositions[0].height + Number.parseFloat(getComputedStyle(body).rowGap || '0')
      for (const event of events) {
        const row = rowRefs.current.get(event.id)
        const nextPosition = nextPositions.get(event.id)
        if (!row || !nextPosition) continue
        const previousPosition = positionsRef.current.get(event.id)
        if (previousPosition) {
          const deltaY = previousPosition.top - nextPosition.top
          if (Math.abs(deltaY) > 0.5) row.animate(
            [{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }],
            { duration: EVENT_ROW_TRANSITION_MS, easing: 'cubic-bezier(.2,.82,.25,1)', fill: 'both' },
          )
        } else row.animate(
          [{ transform: `translateY(${-rowStep}px)`, opacity: 0.88 }, { transform: 'translateY(0)', opacity: 1 }],
          { duration: EVENT_ROW_TRANSITION_MS, easing: 'cubic-bezier(.2,.82,.25,1)', fill: 'both' },
        )
      }
      const currentIds = new Set(events.map((event) => event.id))
      const removed = previousEventsRef.current.filter((event) => !currentIds.has(event.id))
      if (removed.length) {
        const exitingRows = removed.map((event) => {
          const position = positionsRef.current.get(event.id)
          return position ? { ...event, exitId: `${event.id}-${exitIdRef.current += 1}`, top: position.top - bodyRect.top, step: rowStep } : null
        }).filter(Boolean)
        if (exitingRows.length) {
          setExiting((current) => [...current, ...exitingRows])
          const timer = window.setTimeout(() => {
            exitTimersRef.current.delete(timer)
            const exited = new Set(exitingRows.map((event) => event.exitId))
            setExiting((current) => current.filter((event) => !exited.has(event.exitId)))
          }, EVENT_ROW_TRANSITION_MS + 30)
          exitTimersRef.current.add(timer)
        }
      }
    }
    positionsRef.current = nextPositions
    previousEventsRef.current = events
    lastLiveInsertRef.current = liveInsertVersion
  }, [events, liveInsertVersion])

  return <div className="event-log-body" ref={bodyRef}>
    {events.map((event) => <EventRow key={event.id} event={event} rowRef={(node) => setRowRef(event.id, node)} />)}
    {exiting.map((event) => <EventRow key={event.exitId} event={event} className="event-line-exiting" style={{ top: `${event.top}px`, '--event-row-step': `${event.step}px` }} />)}
  </div>
}
