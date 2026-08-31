import express from 'express'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSurviveEventLogSnapshot, startSurviveEventLog, subscribeToSurviveEventLog } from './survive/event-log.mjs'
import { getSurviveStatusSnapshot, startSurviveStatusPoller } from './survive/status-poller.mjs'
import { handleTalkChat } from './survive/chat.mjs'

const production = process.argv.includes('--production')
if (existsSync(resolve('.env'))) process.loadEnvFile(resolve('.env'))
// `npm start` selects production with --production. Align NODE_ENV so that
// development-only provider diagnostics cannot accidentally run in deploys.
if (production) process.env.NODE_ENV = 'production'
const app = express()
const port = Number(process.env.PORT || 5173)

const MAX_EVENT_STREAMS_PER_CLIENT = 3
const MAX_EVENT_STREAMS = 200
const eventStreamsByClient = new Map()
let totalEventStreams = 0

app.disable('x-powered-by')
app.use((_request, response, next) => {
  response.set({
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
  if (production) {
    // The browser consumes only our own API/SSE endpoints. Inline styles are
    // retained because the UI uses React custom properties for animation.
    response.set('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '))
  }
  next()
})
app.use(express.json({ limit: '16kb' }))
app.use((error, _request, response, next) => {
  if (error?.type === 'entity.too.large') return response.status(413).json({ reply: 'request too large.' })
  if (error instanceof SyntaxError && 'body' in error) return response.status(400).json({ reply: 'invalid request.' })
  return next(error)
})

function clientKey(request) {
  return request.ip || request.socket.remoteAddress || 'unknown'
}

function requireSameOrigin(request, response, next) {
  const origin = request.get('origin')
  if (!origin) return next()
  try {
    if (new URL(origin).host === request.get('host')) return next()
  } catch {
    // Treat malformed browser Origin headers as cross-origin requests.
  }
  return response.status(403).json({ reply: 'request rejected.' })
}

// One server-owned status poller refreshes the published state every ten
// seconds. API consumers
// receive this snapshot only; visitor count therefore does not amplify RPC use.
startSurviveStatusPoller()
startSurviveEventLog()

app.get('/api/survive-status', (_request, response) => {
  response.set('Cache-Control', 'no-store')
  response.json(getSurviveStatusSnapshot())
})

app.post('/api/chat', requireSameOrigin, (request, response) => { void handleTalkChat(request, response) })

app.get('/api/event-log', (_request, response) => {
  response.set('Cache-Control', 'no-store')
  response.json(getSurviveEventLogSnapshot())
})

app.get('/api/event-log/stream', (request, response) => {
  const key = clientKey(request)
  const clientStreams = eventStreamsByClient.get(key) ?? 0
  if (clientStreams >= MAX_EVENT_STREAMS_PER_CLIENT || totalEventStreams >= MAX_EVENT_STREAMS) {
    return response.status(429).json({ error: 'stream capacity reached' })
  }
  eventStreamsByClient.set(key, clientStreams + 1)
  totalEventStreams += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    totalEventStreams = Math.max(0, totalEventStreams - 1)
    const remaining = (eventStreamsByClient.get(key) ?? 1) - 1
    if (remaining > 0) eventStreamsByClient.set(key, remaining)
    else eventStreamsByClient.delete(key)
  }
  response.status(200)
  response.set({
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  const unsubscribe = subscribeToSurviveEventLog((payload) => {
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
  })
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25_000)
  request.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    release()
    response.end()
  })
})

if (production) {
  app.use(express.static(resolve('dist')))
  app.use((_request, response) => response.sendFile(resolve('dist/index.html')))
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
}

app.listen(port, () => console.log(`SURVIVE.EXE listening on http://127.0.0.1:${port}`))
