function configuredAddress(value) {
  const address = value?.trim()
  return address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? address : null
}

function heliusUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.hostname.endsWith('helius-rpc.com') ? url : null
  } catch {
    return null
  }
}

function toWebSocketUrl(url) {
  const derived = new URL(url)
  derived.protocol = derived.protocol === 'https:' ? 'wss:' : 'ws:'
  return derived.toString()
}

function toHttpUrl(url) {
  const derived = new URL(url)
  derived.protocol = derived.protocol === 'wss:' ? 'https:' : 'http:'
  return derived.toString()
}

export function getConfig() {
  // Restore the generic RPC used by the original status/indexer pipeline.
  // Helius remains configured separately for the Event Log WebSocket.
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || process.env.HELIUS_RPC_URL?.trim() || null
  const configuredHeliusRpc = process.env.HELIUS_RPC_URL?.trim() || null
  const explicitWss = heliusUrl(process.env.HELIUS_WSS_URL?.trim() || process.env.SOLANA_WSS_URL?.trim())
  const heliusRpc = heliusUrl(configuredHeliusRpc) ?? (explicitWss ? toHttpUrl(explicitWss) : null)
  const heliusWss = explicitWss ? explicitWss.toString() : heliusRpc ? toWebSocketUrl(heliusRpc) : null
  return {
    mint: configuredAddress(process.env.SURVIVE_TOKEN_CA),
    rpcUrl,
    heliusRpcUrl: heliusRpc?.toString() ?? null,
    heliusWssUrl: heliusWss,
  }
}
