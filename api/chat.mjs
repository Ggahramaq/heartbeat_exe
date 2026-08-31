import { handleTalkChat } from '../server/survive/chat.mjs'
import { applyApiSecurityHeaders, hasOversizedJsonBody, isSameOrigin } from '../server/survive/http.mjs'

export default async function handler(request, response) {
  applyApiSecurityHeaders(response)
  if (request.method !== 'POST') return response.status(405).json({ reply: 'method not allowed.' })
  if (!isSameOrigin(request)) return response.status(403).json({ reply: 'request rejected.' })
  if (hasOversizedJsonBody(request)) return response.status(413).json({ reply: 'request too large.' })
  try {
    // Vercel provides a parsed request.body helper. Access it once so malformed
    // JSON returns a safe client error rather than reaching chat processing.
    void request.body
  } catch {
    return response.status(400).json({ reply: 'invalid request.' })
  }
  return handleTalkChat(request, response)
}
