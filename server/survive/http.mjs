const API_SECURITY_HEADERS = {
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export function applyApiSecurityHeaders(response, cacheControl = 'no-store') {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) response.setHeader(name, value)
  response.setHeader('Cache-Control', cacheControl)
}

export function isSameOrigin(request) {
  const origin = request.headers?.origin
  if (!origin) return true
  const host = request.headers?.host
  try { return new URL(origin).host === host } catch { return false }
}

export function hasOversizedJsonBody(request, limitBytes = 16 * 1024) {
  const rawLength = request.headers?.['content-length']
  const length = Number(rawLength)
  return Number.isFinite(length) && length > limitBytes
}
