import { applyApiSecurityHeaders } from '../server/survive/http.mjs'
import { getVercelStatusPlaceholder, resolveVercelSurviveStatus } from '../server/survive/vercel-status-service.mjs'

const STATUS_CACHE_CONTROL = 'public, s-maxage=5, stale-while-revalidate=10'

export default async function handler(request, response) {
  applyApiSecurityHeaders(response)
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method Not Allowed' })
  try {
    const snapshot = await resolveVercelSurviveStatus()
    // Do not CDN-cache a cold-start partial response. That lets the browser
    // retry promptly while keeping complete public snapshots shared at Vercel.
    if (snapshot.balanceUsd !== null || snapshot.holderCount !== null || snapshot.birthTimestamp !== null) {
      response.setHeader('Cache-Control', STATUS_CACHE_CONTROL)
      response.setHeader('Vercel-CDN-Cache-Control', STATUS_CACHE_CONTROL)
    }
    return response.status(200).json(snapshot)
  } catch (error) {
    console.error('[vercel:status]', {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    })
    // CA remains available even when every provider is unavailable.
    return response.status(200).json({
      ...getVercelStatusPlaceholder(),
      error: 'Unable to resolve SURVIVE status',
    })
  }
}
