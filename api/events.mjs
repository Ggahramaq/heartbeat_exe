import { getRecentSurviveEvents } from '../server/survive/events-service.mjs'
import { applyApiSecurityHeaders } from '../server/survive/http.mjs'

const EVENT_CACHE_CONTROL = 'public, s-maxage=2, stale-while-revalidate=5'

export default async function handler(request, response) {
  applyApiSecurityHeaders(response, EVENT_CACHE_CONTROL)
  response.setHeader('Vercel-CDN-Cache-Control', EVENT_CACHE_CONTROL)
  if (request.method !== 'GET') return response.status(405).json({ error: 'method not allowed' })
  try {
    return response.status(200).json({ error: false, events: await getRecentSurviveEvents(), updatedAt: Date.now(), streaming: false })
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') console.error(`[vercel:events] ${error.message}`)
    return response.status(200).json({ error: true, events: [], updatedAt: Date.now(), streaming: false })
  }
}
