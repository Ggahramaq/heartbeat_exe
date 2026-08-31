import { PublicKey } from '@solana/web3.js'
import { getConfig } from './config.mjs'
import { decodePumpTradeEvents, lamportsToSol } from './pump-events.mjs'
import { canonicalPumpSwapPool, connectionFor, getPumpBondingCurve } from './solana.mjs'

const MAX_EVENT_BUFFER = 500
const MAX_SEEN_SIGNATURES = 2_000
const INITIAL_HISTORY_LIMIT = 10
const HISTORY_CONCURRENCY = 4
const KEEP_ALIVE_MS = 60_000
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000]

let started = false
let stopped = false
let configuring = false
let socket = null
let reconnectTimer = null
let keepAliveTimer = null
let reconnectAttempt = 0
let context = null
let events = []
let hasError = false
let lastError = null
const listeners = new Set()
const seenSignatures = new Set()
const seenSignatureOrder = []

function developmentLog(message) {
  if (process.env.NODE_ENV !== 'production') console.info(`[event-log] ${message}`)
}

function developmentError(error) {
  if (process.env.NODE_ENV !== 'production') console.warn(`[event-log:error] ${error?.message ?? String(error)}`)
}

function publicSnapshot() {
  return {
    error: hasError,
    connected: socket?.readyState === WebSocket.OPEN,
    events: hasError ? [] : events.slice(0, 5),
    updatedAt: Date.now(),
  }
}

function broadcast(payload = { kind: 'snapshot', ...publicSnapshot() }) {
  for (const listener of listeners) {
    try { listener(payload) } catch { listeners.delete(listener) }
  }
}

function setError(error) {
  hasError = true
  lastError = error?.message ?? String(error)
  developmentError(error)
  broadcast()
}

function clearError() {
  if (!hasError) return
  hasError = false
  lastError = null
  broadcast()
}

function rememberSignature(signature) {
  if (seenSignatures.has(signature)) return false
  seenSignatures.add(signature)
  seenSignatureOrder.push(signature)
  while (seenSignatureOrder.length > MAX_SEEN_SIGNATURES) {
    const oldest = seenSignatureOrder.shift()
    if (oldest) seenSignatures.delete(oldest)
  }
  return true
}

function normalizeEvents(signature, decoded) {
  const result = []
  for (const trade of decoded) {
    result.push({
      id: `${signature}:${trade.eventIndex}:trade`,
      signature,
      timestamp: trade.timestampMs,
      type: trade.type,
      tone: trade.tone,
      amountSol: lamportsToSol(trade.amountLamports),
    })
    if (trade.feeLamports > 0n) {
      result.push({
        id: `${signature}:${trade.eventIndex}:fee`,
        signature,
        timestamp: trade.timestampMs,
        type: 'FEE',
        tone: 'positive',
        amountSol: lamportsToSol(trade.feeLamports),
      })
    }
  }
  return result
}

function appendEvents(incoming) {
  if (!incoming.length) return
  events = [...incoming, ...events]
    .sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id))
    .slice(0, MAX_EVENT_BUFFER)
  developmentLog(`buffer size: ${events.length}`)
  broadcast({ kind: 'events', events: incoming })
}

function decodeAndAppend(signature, logMessages, fallbackTimestampMs) {
  if (!context || !rememberSignature(signature)) return
  const decoded = decodePumpTradeEvents({
    logMessages,
    mint: context.mint,
    pool: context.pool,
    fallbackTimestampMs,
  })
  const normalized = normalizeEvents(signature, decoded)
  for (const event of normalized) developmentLog(`decoded: ${event.type} ${event.amountSol.toFixed(6)} SOL`)
  appendEvents(normalized)
}

function clearSocketTimers() {
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  keepAliveTimer = null
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (context) openSocket()
    else void configure()
  }, delay)
}

function restartAfterFailure(error) {
  setError(error)
  clearSocketTimers()
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  scheduleReconnect()
}

function subscribeToTargets() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !context) return
  context.targets.forEach((target, index) => {
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'logsSubscribe',
      params: [{ mentions: [target.toBase58()] }, { commitment: 'confirmed' }],
    }))
    developmentLog(`subscribed: ${target.toBase58()}`)
  })
}

function handleSocketMessage(message) {
  let payload
  try { payload = JSON.parse(String(message.data)) } catch (error) {
    restartAfterFailure(new Error(`malformed Helius response: ${error.message}`))
    return
  }
  if (payload.error) {
    restartAfterFailure(new Error(`Helius subscription failure: ${payload.error.message ?? 'unknown error'}`))
    return
  }
  if (payload.method !== 'logsNotification') return
  const value = payload.params?.result?.value
  if (!value || typeof value.signature !== 'string') {
    restartAfterFailure(new Error('malformed Helius logs notification'))
    return
  }
  if (value.err) return
  try {
    developmentLog(`tx received: ${value.signature}`)
    decodeAndAppend(value.signature, value.logs, Date.now())
  } catch (error) {
    restartAfterFailure(new Error(`event decoder failure: ${error.message}`))
  }
}

function openSocket() {
  if (stopped || !context || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
  try {
    const nextSocket = new WebSocket(context.wssUrl)
    socket = nextSocket
    nextSocket.addEventListener('open', () => {
      if (socket !== nextSocket) return
      reconnectAttempt = 0
      clearError()
      developmentLog('connected to Helius')
      subscribeToTargets()
      // Helius recommends regular activity to avoid the standard WSS idle timeout.
      keepAliveTimer = setInterval(() => {
        if (nextSocket.readyState === WebSocket.OPEN) {
          nextSocket.send(JSON.stringify({ jsonrpc: '2.0', id: 99_999, method: 'getHealth', params: [] }))
        }
      }, KEEP_ALIVE_MS)
    })
    nextSocket.addEventListener('message', handleSocketMessage)
    nextSocket.addEventListener('error', () => {
      if (socket === nextSocket) setError(new Error('Helius WebSocket failure'))
    })
    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) return
      socket = null
      clearSocketTimers()
      if (!stopped) {
        setError(new Error('Helius WebSocket closed'))
        scheduleReconnect()
      }
    })
  } catch (error) {
    restartAfterFailure(error)
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function loadRecentHistory() {
  if (!context) return
  const entries = (await Promise.all(context.targets.map(async (target) => {
    const rows = await context.connection.getSignaturesForAddress(target, { limit: INITIAL_HISTORY_LIMIT })
    return rows.map((row) => ({ ...row, signature: row.signature }))
  }))).flat()
  const unique = [...new Map(entries.map((entry) => [entry.signature, entry])).values()]
    .filter((entry) => !entry.err)
    .sort((left, right) => (right.blockTime ?? 0) - (left.blockTime ?? 0))
    .slice(0, INITIAL_HISTORY_LIMIT)

  await mapWithConcurrency(unique, HISTORY_CONCURRENCY, async (entry) => {
    if (!rememberSignature(entry.signature)) return
    const transaction = await context.connection.getTransaction(entry.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (!transaction) return
    const decoded = decodePumpTradeEvents({
      logMessages: transaction.meta?.logMessages,
      mint: context.mint,
      pool: context.pool,
      fallbackTimestampMs: transaction.blockTime ? transaction.blockTime * 1_000 : Date.now(),
    })
    appendEvents(normalizeEvents(entry.signature, decoded))
  })
}

async function configure() {
  if (configuring || stopped) return
  configuring = true
  try {
    const config = getConfig()
    if (!config.mint || !config.heliusRpcUrl || !config.heliusWssUrl) {
      throw new Error('Helius RPC/WSS configuration is unavailable')
    }
    const connection = connectionFor(config.heliusRpcUrl)
    const mint = new PublicKey(config.mint)
    const curve = await getPumpBondingCurve(connection, config.mint)
    if (!curve) throw new Error('configured mint has no official Pump bonding curve')
    const pool = canonicalPumpSwapPool(config.mint)
    context = {
      connection,
      mint,
      pool,
      wssUrl: config.heliusWssUrl,
      // Keep both precise accounts subscribed. This also carries the log
      // cleanly through a bonding-curve → PumpSwap graduation.
      targets: [curve.address, pool],
    }
    openSocket()
    void loadRecentHistory().catch((error) => restartAfterFailure(new Error(`initial history failure: ${error.message}`)))
  } catch (error) {
    setError(error)
    scheduleReconnect()
  } finally {
    configuring = false
  }
}

export function startSurviveEventLog() {
  if (started) return
  started = true
  stopped = false
  void configure()
}

export function getSurviveEventLogSnapshot() {
  return publicSnapshot()
}

export function subscribeToSurviveEventLog(listener) {
  listeners.add(listener)
  listener({ kind: 'snapshot', ...publicSnapshot() })
  return () => listeners.delete(listener)
}

export function stopSurviveEventLog() {
  stopped = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  clearSocketTimers()
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  socket = null
}
