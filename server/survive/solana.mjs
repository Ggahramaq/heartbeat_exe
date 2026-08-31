import { Connection, PublicKey } from '@solana/web3.js'

// These canonical public program addresses are the only values this service
// needed from @solana/spl-token. Keeping them local removes an otherwise
// unused dependency tree from the production server.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkN4kF5UHeaZvZcxAMQ9F7gFx')

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112')
let nextRpcReadAt = 0
let nextInitialIndexReadAt = 0
// This one application-wide gate covers standard Helius Solana reads used by
// compatibility fallbacks, the price feed, and creation scan. The enhanced
// Helius history/holder methods below have their own bounded request paths.
const RPC_READ_INTERVAL_MS = 500
// Standard JSON-RPC fallback batches still need bounded pressure, leaving
// capacity for status/price/holder reads on the same Helius endpoint.
const INITIAL_INDEX_READ_INTERVAL_MS = 100

function isHardProviderQuota(error) {
  return /daily request limit|monthly request limit|quota (?:is )?exceeded|usage limit exceeded/i.test(error?.message ?? '')
}

function isRetryableProviderError(error) {
  return !isHardProviderQuota(error)
    && /429|too many requests|request limit|rate limit|fetch failed|timed?out/i.test(error?.message ?? '')
}

async function reserveRpcRead() {
  const scheduledAt = Math.max(Date.now(), nextRpcReadAt)
  nextRpcReadAt = scheduledAt + RPC_READ_INTERVAL_MS
  const waitMs = scheduledAt - Date.now()
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
  return waitMs
}

export function connectionFor(rpcUrl) {
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is not configured')
  // web3.js otherwise performs its own opaque 500/1000/2000/4000ms retry
  // sequence before our quota-aware circuit breaker can inspect the error.
  return new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  })
}

async function heliusRpcRequest(rpcUrl, method, params, label = method) {
  if (!rpcUrl) throw new Error('HELIUS_RPC_URL is not configured')
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.error) {
        const message = payload?.error?.message ?? `${label} HTTP ${response.status}`
        throw new Error(message)
      }
      return payload?.result
    } catch (error) {
      lastError = error
      if (!isRetryableProviderError(error) || attempt === 2) break
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError ?? new Error(`${label} failed`)
}

/** Helius-only enhanced history request; callers can fall back to standard RPC. */
export async function getHeliusTransactionsForAddress(rpcUrl, address, options = {}) {
  return heliusRpcRequest(rpcUrl, 'getTransactionsForAddress', [address, {
    transactionDetails: 'full',
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
    limit: 100,
    sortOrder: 'asc',
    filters: { status: 'succeeded' },
    ...options,
  }], 'Helius transaction history')
}

export async function rpcWithRetry(operation, label = 'RPC read', perf) {
  let lastError
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const queueWaitMs = await reserveRpcRead()
    if (perf) {
      perf.rpcQueueWaitMs = (perf.rpcQueueWaitMs ?? 0) + queueWaitMs
      perf.rpcCalls = (perf.rpcCalls ?? 0) + 1
    }
    const requestStartedAt = performance.now()
    try { return await operation() } catch (error) {
      lastError = error
      const retryable = isRetryableProviderError(error)
      if (!retryable || attempt === 6) break
      const retryDelayMs = 700 * 2 ** attempt
      // Hold the shared queue through the provider's retry window so another
      // subsystem cannot immediately create the same rate-limit failure.
      nextRpcReadAt = Math.max(nextRpcReadAt, Date.now() + retryDelayMs)
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    } finally {
      if (perf) perf.rpcRequestMs = (perf.rpcRequestMs ?? 0) + (performance.now() - requestStartedAt)
    }
  }
  throw lastError ?? new Error(`${label} failed`)
}

async function reserveInitialIndexReads(requestCount) {
  const scheduledAt = Math.max(Date.now(), nextInitialIndexReadAt)
  nextInitialIndexReadAt = scheduledAt + INITIAL_INDEX_READ_INTERVAL_MS * Math.max(1, requestCount)
  const waitMs = scheduledAt - Date.now()
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
  return waitMs
}

export async function initialIndexBatchRpc(operation, requestCount, label = 'Initial index batch', perf) {
  let lastError
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const queueWaitMs = await reserveInitialIndexReads(requestCount)
    if (perf) {
      perf.rpcQueueWaitMs = (perf.rpcQueueWaitMs ?? 0) + queueWaitMs
      perf.rpcCalls = (perf.rpcCalls ?? 0) + requestCount
      perf.rpcBatches = (perf.rpcBatches ?? 0) + 1
    }
    const requestStartedAt = performance.now()
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const retryable = isRetryableProviderError(error)
      if (!retryable || attempt === 6) break
      const retryDelayMs = 700 * 2 ** attempt
      nextInitialIndexReadAt = Math.max(nextInitialIndexReadAt, Date.now() + retryDelayMs)
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    } finally {
      if (perf) perf.rpcRequestMs = (perf.rpcRequestMs ?? 0) + (performance.now() - requestStartedAt)
    }
  }
  throw lastError ?? new Error(`${label} failed`)
}

// Kept as the indexer's semantic call-site; rpcWithRetry now owns the shared
// application-wide rate gate above.
export async function throttledRpc(operation, label = 'RPC read', perf) {
  return rpcWithRetry(operation, label, perf)
}

export async function getPositiveHolderCount(connection, mintAddress, heliusRpcUrl) {
  const mint = new PublicKey(mintAddress)
  const mintInfo = await rpcWithRetry(() => connection.getAccountInfo(mint), 'Mint account read')
  if (!mintInfo) throw new Error('Configured mint does not exist')
  if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error('Configured mint is not owned by a supported SPL Token program')
  }
  const scanStartedAt = performance.now()
  const owners = new Map()
  let accountCount = 0
  let pages = 0
  let paginationKey

  // Helius V2 supports cursor pagination, a 10,000-account page, filters,
  // and a data slice. The slice starts at the token-account owner and includes
  // its raw u64 amount, so thousands of holders do not require full account
  // payloads or one RPC request per wallet.
  do {
    const result = await heliusRpcRequest(heliusRpcUrl, 'getProgramAccountsV2', [mintInfo.owner.toBase58(), {
      commitment: 'confirmed',
      encoding: 'base64',
      withContext: true,
      limit: 10_000,
      ...(paginationKey ? { paginationKey } : {}),
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint.toBase58() } },
      ],
      // SPL token account: owner = 32..63, amount = 64..71.
      dataSlice: { offset: 32, length: 40 },
    }], 'Helius getProgramAccountsV2')
    const page = result?.value ?? result
    const accounts = Array.isArray(page?.accounts) ? page.accounts : []
    pages += 1
    accountCount += accounts.length
    for (const entry of accounts) {
      const encoded = entry?.account?.data?.[0]
      if (typeof encoded !== 'string') continue
      const data = Buffer.from(encoded, 'base64')
      if (data.length !== 40) continue
      const owner = new PublicKey(data.subarray(0, 32)).toBase58()
      const amount = data.readBigUInt64LE(32)
      owners.set(owner, (owners.get(owner) ?? 0n) + amount)
    }
    paginationKey = page?.paginationKey ?? null
  } while (paginationKey)

  const rawHolderCount = [...owners.values()].filter((amount) => amount > 0n).length
  return {
    rawHolderCount,
    accountCount,
    pages,
    resolvedMs: Math.round(performance.now() - scanStartedAt),
    source: 'helius-getProgramAccountsV2',
  }
}

export async function getPumpBondingCurve(connection, mintAddress) {
  const mint = new PublicKey(mintAddress)
  const [address] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID)
  const account = await rpcWithRetry(() => connection.getAccountInfo(address), 'Pump bonding-curve read')
  if (!account || !account.owner.equals(PUMP_PROGRAM_ID) || account.data.length < 81) return null
  // Official Pump BondingCurve layout: 8-byte discriminator, five u64s,
  // `complete` bool, then the creator public key.
  const complete = account.data[48] === 1
  const creator = new PublicKey(account.data.subarray(49, 81))
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM_ID)
  return { address, creator, creatorVault, complete }
}

// The PumpSwap SDK derives SOL pools with these exact public PDA seeds.
// Keeping the derivation here lets the indexer verify an AMM event belongs to
// this mint without querying a token analytics service.
export function canonicalPumpSwapPool(mintAddress) {
  const mint = new PublicKey(mintAddress)
  const [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), mint.toBuffer()], PUMP_PROGRAM_ID)
  const poolIndex = Buffer.alloc(2)
  poolIndex.writeUInt16LE(0)
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), poolIndex, poolAuthority.toBuffer(), mint.toBuffer(), NATIVE_MINT.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  )
  return pool
}
