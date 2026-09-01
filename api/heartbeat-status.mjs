import { applyApiSecurityHeaders } from '../server/survive/http.mjs'
import { getVercelHeartbeatStatusPlaceholder, resolveVercelHeartbeatStatus } from '../server/survive/vercel-status-service.mjs'

const STATUS_CACHE_CONTROL = 'public, s-maxage=5, stale-while-revalidate=10'

/** Canonical public status endpoint for HEARTBEAT.EXE. */
export default async function handler(request, response) {
  applyApiSecurityHeaders(response)
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method Not Allowed' })
  try {
    const snapshot = await resolveVercelHeartbeatStatus()
    if (snapshot.balanceUsd !== null || snapshot.holderCount !== null || snapshot.deploymentTimestamp !== null) {
      response.setHeader('Cache-Control', STATUS_CACHE_CONTROL)
      response.setHeader('Vercel-CDN-Cache-Control', STATUS_CACHE_CONTROL)
    }
    return response.status(200).json(snapshot)
  } catch (error) {
    console.error('[heartbeat-status]', {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    })
    return response.status(200).json({
      ...getVercelHeartbeatStatusPlaceholder(),
      error: 'Unable to resolve HEARTBEAT status',
    })
  }
}
