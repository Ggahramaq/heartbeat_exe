import { applyApiSecurityHeaders, hasOversizedJsonBody, isSameOrigin } from '../server/survive/http.mjs'
import { handleVercelTalkChat } from '../server/survive/vercel-chat-service.mjs'

export default async function handler(request, response) {
  applyApiSecurityHeaders(response)
  try {
    console.log('[chat] handler start')
    console.log(`[chat] method=${request.method}`)
    if (request.method !== 'POST') return response.status(405).json({ error: 'Method Not Allowed' })
    if (!isSameOrigin(request)) return response.status(403).json({ reply: 'request rejected.' })
    if (hasOversizedJsonBody(request)) return response.status(413).json({ reply: 'request too large.' })
    // Vercel provides a parsed request.body helper. Access it once so malformed
    // JSON returns a safe client error rather than reaching chat processing.
    void request.body
  } catch {
    return response.status(400).json({ reply: 'invalid request.' })
  }
  try {
    console.log('[chat] preparing provider')
    return await handleVercelTalkChat(request, response)
  } catch (error) {
    console.error('[chat] handler failed', { name: error?.name, message: error?.message, stack: error?.stack })
    return response.status(500).json({ error: 'Unable to respond', reply: 'i cannot hear you right now.' })
  }
}
