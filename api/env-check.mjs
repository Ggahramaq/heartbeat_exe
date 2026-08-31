import { applyApiSecurityHeaders } from '../server/survive/http.mjs'
import { getEnvironmentAvailability } from '../server/survive/env-check.mjs'

/** Safe deployment diagnostic: reports presence only, never values. */
export default function handler(request, response) {
  applyApiSecurityHeaders(response, 'no-store')
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method Not Allowed' })

  const env = getEnvironmentAvailability()
  return response.status(200).json({
    ok: Object.values(env).every(Boolean),
    env,
  })
}
