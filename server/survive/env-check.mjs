const REQUIRED_ENVIRONMENT_VARIABLES = [
  'SURVIVE_TOKEN_CA',
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
  return Object.fromEntries(
    REQUIRED_ENVIRONMENT_VARIABLES.map((name) => [name, Boolean(process.env[name]?.trim())]),
  )
}
