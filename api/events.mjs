import { applyApiSecurityHeaders } from '../server/survive/http.mjs'
import { getRecentVercelEvents } from '../server/survive/vercel-events-service.mjs'

const EVENT_CACHE_CONTROL = 'public, s-maxage=2, stale-while-revalidate=5'

export default async function handler(request, response) {
  applyApiSecurityHeaders(response, EVENT_CACHE_CONTROL)
  response.setHeader('Vercel-CDN-Cache-Control', EVENT_CACHE_CONTROL)
  try {
    console.log('[events] handler start')
    if (request.method !== 'GET') return response.status(405).json({ error: 'Method Not Allowed' })
    console.log(`[events] mint=${process.env.SURVIVE_TOKEN_CA?.trim() || 'unconfigured'}`)
    const events = await getRecentVercelEvents()
    console.log(`[events] returning=${events.length}`)
    return response.status(200).json({ error: false, events, updatedAt: Date.now(), streaming: false })
  } catch (error) {
    console.error('[events] failed', { name: error?.name, message: error?.message, stack: error?.stack })
    // A temporary provider failure is an Event Log state, not a Vercel crash.
    // Returning JSON keeps the frontend's existing error treatment intact.
    return response.status(200).json({ error: true, events: [], updatedAt: Date.now(), streaming: false })
  }
}
