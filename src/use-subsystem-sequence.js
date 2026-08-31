import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Shared CRT boot/shutdown controller for executable-style subsystem pages. */
export function useSubsystemSequence(sectionOrder, onExit) {
  const [frameActive, setFrameActive] = useState(false)
  const [internalsLive, setInternalsLive] = useState(false)
  const [activated, setActivated] = useState([])
  const [shutdownCursor, setShutdownCursor] = useState(null)
  const [frameShuttingDown, setFrameShuttingDown] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return undefined
    const timer = window.setTimeout(() => {
      started.current = true
      setFrameActive(true)
    }, 55)
    return () => window.clearTimeout(timer)
  }, [])

  const startNext = useCallback(() => {
    setInternalsLive(true)
    setActivated((current) => current.length >= sectionOrder.length
      ? current
      : [...current, sectionOrder[current.length]])
  }, [sectionOrder])
  const isActive = useCallback((key) => activated.includes(key), [activated])
  const isBootComplete = activated.length >= sectionOrder.length
  const shutdownOrder = useMemo(() => [...activated].reverse(), [activated])
  const shutdownKey = shutdownCursor === null ? null : shutdownOrder[shutdownCursor]
  const finishFrame = useCallback(() => { onExit?.() }, [onExit])
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
  const beginShutdown = useCallback(() => {
    if (shutdownCursor !== null || frameShuttingDown || !activated.length) return false
    setShutdownCursor(0)
    return true
  }, [activated.length, frameShuttingDown, shutdownCursor])

  return {
    frameActive, internalsLive, isActive, isBootComplete, startNext,
    shutdownKey, frameShuttingDown, startShutdownNext,
    completeShutdown, advanceInstantShutdown, beginShutdown, finishFrame,
  }
}
