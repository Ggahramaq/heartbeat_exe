import { useEffect, useRef, useState } from 'react'

const ON_MS = 88
const OFF_MS = 62
const FLASH_COUNT = 2

/** Every subsystem locks with one fast CRT pulse: ON → OFF → ON. */
export function BootSection({ active, onFirstOff, shuttingDown = false, onShutdownOff, onShutdownComplete, className = '', children }) {
  const [phase, setPhase] = useState('waiting')
  const hasRun = useRef(false)
  const firedFirstOff = useRef(false)
  const shutdownStarted = useRef(false)
  const shutdownOffRef = useRef(onShutdownOff)
  const shutdownCompleteRef = useRef(onShutdownComplete)
  shutdownOffRef.current = onShutdownOff
  shutdownCompleteRef.current = onShutdownComplete

  useEffect(() => {
    if (!active || hasRun.current) return
    let cancelled = false
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    async function boot() {
      for (let pulse = 0; pulse < FLASH_COUNT; pulse += 1) {
        if (cancelled) return
        setPhase('on')
        await wait(ON_MS + (pulse === 0 ? 9 : 0))
        if (cancelled || pulse === FLASH_COUNT - 1) return
        setPhase('off')
        if (!firedFirstOff.current) {
          firedFirstOff.current = true
          onFirstOff?.()
        }
        await wait(OFF_MS)
      }
    }
    // A microtask lets Strict Mode discard its development-only first effect
    // pass without adding a visible delay between an OFF beat and the next ON.
    queueMicrotask(() => {
      if (cancelled || hasRun.current) return
      hasRun.current = true
      boot()
    })
    return () => { cancelled = true }
  }, [active, onFirstOff])

  useEffect(() => {
    if (!shuttingDown || shutdownStarted.current) return
    shutdownStarted.current = true
    let cancelled = false
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    async function shutdown() {
      // Reverse lock: visible → hidden → visible → hidden. The next section
      // is released at the first OFF edge, while this one finishes behind it.
      setPhase('on')
      await wait(76)
      if (cancelled) return
      setPhase('off')
      shutdownOffRef.current?.()
      await wait(48)
      if (cancelled) return
      setPhase('on')
      await wait(70)
      if (cancelled) return
      setPhase('off')
      shutdownCompleteRef.current?.()
    }
    void shutdown()
    return () => { cancelled = true }
  // Parent state advances at the first OFF edge. Do not include callback
  // identities here: that re-render would cancel this pulse halfway through
  // and strand the route transition before the frame can finish.
  }, [shuttingDown])

  return (
    <div className={`boot-section boot-${phase} ${className}`} aria-hidden={phase === 'waiting'}>
      {children}
    </div>
  )
}

/** Instant hardware switch: hidden until selected, then permanently present. */
export function InstantBootSection({ active, onActivated, shuttingDown = false, onShutdown, className = '', children }) {
  const [visible, setVisible] = useState(false)
  const hasRun = useRef(false)
  const shutdownStarted = useRef(false)

  useEffect(() => {
    if (!active || hasRun.current) return
    let cancelled = false

    // Preserve the Strict Mode guard without inserting a visible beat between
    // a switch snapping on and the next queued subsystem starting.
    queueMicrotask(() => {
      if (cancelled || hasRun.current) return
      hasRun.current = true
      setVisible(true)
      onActivated?.()
    })

    return () => { cancelled = true }
  }, [active, onActivated])

  useEffect(() => {
    if (!shuttingDown || shutdownStarted.current) return
    shutdownStarted.current = true
    setVisible(false)
    onShutdown?.()
  }, [shuttingDown, onShutdown])

  return (
    <div className={`boot-section ${visible ? 'boot-instant' : 'boot-waiting'} ${className}`} aria-hidden={!visible}>
      {children}
    </div>
  )
}
