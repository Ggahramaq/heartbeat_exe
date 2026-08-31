import { useEffect, useRef, useState } from 'react'

export const EVENT_LOG_RENDER_INTERVAL_MS = 500
const EVENT_LOG_FETCH_INTERVAL_MS = 2_000
const MAX_VISIBLE_EVENTS = 5
const LIVE_INSERT_CADENCE_MS = 100
const MAX_SEQUENTIAL_LIVE_EVENTS = 5

const INITIAL = { error: false, events: [], liveInsertVersion: 0 }

function sortNewestFirst(events) {
  return [...(Array.isArray(events) ? events : [])]
    .sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id))
}

function newestFirst(events) {
  return sortNewestFirst(events).slice(0, MAX_VISIBLE_EVENTS)
}

export function useEventLog() {
  const [visible, setVisible] = useState(INITIAL)
  const pendingRef = useRef({ error: false, snapshot: null, events: new Map() })
  const liveQueueRef = useRef([])
  const queuedIdsRef = useRef(new Set())
  const drainTimerRef = useRef(null)
  const knownEventIdsRef = useRef(new Set())

  useEffect(() => {
    const stopDrain = () => {
      if (drainTimerRef.current) window.clearTimeout(drainTimerRef.current)
      drainTimerRef.current = null
      liveQueueRef.current = []
      queuedIdsRef.current.clear()
    }

    const drainLiveQueue = () => {
      const next = liveQueueRef.current.shift()
      if (!next) {
        drainTimerRef.current = null
        return
      }
      queuedIdsRef.current.delete(next.id)
      setVisible((current) => {
        if (current.error || current.events.some((event) => event.id === next.id)) return current
        return {
          error: false,
          events: newestFirst([next, ...current.events]),
          liveInsertVersion: current.liveInsertVersion + 1,
        }
      })
      drainTimerRef.current = window.setTimeout(drainLiveQueue, LIVE_INSERT_CADENCE_MS)
    }

    const enqueueLiveEvents = (events) => {
      // Insert oldest-to-newest so the newest transaction is the stable top
      // row once a 500ms server batch has finished entering the buffer.
      const ordered = sortNewestFirst(events).reverse()
      if (ordered.length > MAX_SEQUENTIAL_LIVE_EVENTS) {
        stopDrain()
        setVisible((current) => ({
          error: false,
          events: newestFirst([...events, ...current.events]),
          liveInsertVersion: current.liveInsertVersion,
        }))
        return
      }
      for (const event of ordered) {
        if (queuedIdsRef.current.has(event.id)) continue
        queuedIdsRef.current.add(event.id)
        liveQueueRef.current.push(event)
      }
      if (!drainTimerRef.current) drainLiveQueue()
    }

    const queue = (payload) => {
      if (payload.error) {
        pendingRef.current = { error: true, snapshot: null, events: new Map() }
        return
      }
      if (payload.kind === 'snapshot') {
        pendingRef.current.snapshot = payload.events ?? []
        pendingRef.current.events.clear()
        pendingRef.current.error = false
        return
      }
      for (const event of payload.events ?? []) pendingRef.current.events.set(event.id, event)
      pendingRef.current.error = false
    }

    let cancelled = false
    let initialSnapshot = true
    let recoveringFromError = false
    let stream = null
    let fetchTimer = null
    const rememberEventIds = (events) => {
      for (const event of events) knownEventIdsRef.current.add(event.id)
      while (knownEventIdsRef.current.size > 100) {
        const oldest = knownEventIdsRef.current.values().next().value
        knownEventIdsRef.current.delete(oldest)
      }
    }
    const fetchEvents = async () => {
      try {
        const response = await fetch('/api/events', { cache: 'no-store' })
        if (!response.ok) throw new Error('Event Log request failed')
        const payload = await response.json()
        if (cancelled) return
        if (payload.error) {
          recoveringFromError = true
          queue({ error: true })
          return
        }
        const events = Array.isArray(payload.events) ? payload.events : []
        if (payload.streaming) {
          if (!stream) {
            initialSnapshot = false
            recoveringFromError = false
            knownEventIdsRef.current = new Set(events.map((event) => event.id))
            queue({ kind: 'snapshot', events })
            stream = new EventSource('/api/event-log/stream')
            stream.onmessage = (message) => {
              try {
                const livePayload = JSON.parse(message.data)
                if (livePayload.kind === 'snapshot') knownEventIdsRef.current = new Set((livePayload.events ?? []).map((event) => event.id))
                else rememberEventIds(livePayload.events ?? [])
                queue(livePayload)
              } catch { pendingRef.current.error = true }
            }
            stream.onerror = () => {
              if (cancelled) return
              stream?.close()
              stream = null
              recoveringFromError = true
              queue({ error: true })
              startPolling()
            }
            if (fetchTimer) window.clearInterval(fetchTimer)
            fetchTimer = null
          }
          return
        }
        if (initialSnapshot || recoveringFromError) {
          initialSnapshot = false
          recoveringFromError = false
          knownEventIdsRef.current = new Set(events.map((event) => event.id))
          queue({ kind: 'snapshot', events })
          return
        }
        const incoming = events.filter((event) => !knownEventIdsRef.current.has(event.id))
        rememberEventIds(events)
        if (incoming.length) queue({ kind: 'events', events: incoming })
      } catch {
        if (!cancelled) {
          recoveringFromError = true
          queue({ error: true })
        }
      }
    }

    const startPolling = () => {
      if (!fetchTimer) fetchTimer = window.setInterval(() => { void fetchEvents() }, EVENT_LOG_FETCH_INTERVAL_MS)
    }
    startPolling()
    void fetchEvents()

    const renderTimer = window.setInterval(() => {
      const pending = pendingRef.current
      if (pending.error) {
        stopDrain()
        setVisible((current) => ({ error: true, events: [], liveInsertVersion: current.liveInsertVersion }))
      } else if (pending.snapshot) {
        // Startup/recovery history is intentionally static. Only events that
        // arrive after this snapshot use the physical row-shift animation.
        stopDrain()
        // React may run the state updater after this interval callback exits.
        // Keep an immutable local copy before clearing the pending buffer so
        // the initial Event Log snapshot cannot become null mid-update.
        const snapshot = pending.snapshot
        pending.snapshot = null
        setVisible((current) => ({
          error: false,
          events: newestFirst(snapshot),
          liveInsertVersion: current.liveInsertVersion ?? 0,
        }))
      } else if (pending.events.size) {
        const incoming = [...pending.events.values()]
        pending.events.clear()
        enqueueLiveEvents(incoming)
      }
    }, EVENT_LOG_RENDER_INTERVAL_MS)

    return () => {
      cancelled = true
      if (fetchTimer) window.clearInterval(fetchTimer)
      stream?.close()
      window.clearInterval(renderTimer)
      stopDrain()
    }
  }, [])

  return visible
}
