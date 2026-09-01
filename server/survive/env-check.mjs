const REQUIRED_ENVIRONMENT_VARIABLES = [
  'HEARTBEAT_TOKEN_CA',
  'SOLANA_RPC_URL',
  'SOLANA_WSS_URL',
  'BIRDEYE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_CHAT_MODEL',
]

/**
 * Public deployment diagnostic. This deliberately exposes only whether each
 * required variable is non-empty; provider URLs, keys, and token values stay
 * server-only.
 */
export function getEnvironmentAvailability() {
  const env = Object.fromEntries(REQUIRED_ENVIRONMENT_VARIABLES.map((name) => [name, Boolean(process.env[name]?.trim())]))
  // Existing deployments can use the former token variable until manually
  // migrated. The canonical readiness field treats either value as configured.
  env.HEARTBEAT_TOKEN_CA = Boolean(process.env.HEARTBEAT_TOKEN_CA?.trim() || process.env.SURVIVE_TOKEN_CA?.trim())
  env.SURVIVE_TOKEN_CA = Boolean(process.env.SURVIVE_TOKEN_CA?.trim())
  return env
}
