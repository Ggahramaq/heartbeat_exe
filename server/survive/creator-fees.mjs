import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { readMintIndex, writeMintIndex } from './index-store.mjs'
import { easternMidnightUtcMs } from './time.mjs'
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  canonicalPumpSwapPool,
  getHeliusTransactionsForAddress,
  getPumpBondingCurve,
  initialIndexBatchRpc,
  rpcWithRetry,
} from './solana.mjs'

// Official Pump Fees program. Its sharing-config PDA determines whether a
// coin's creator revenue is split among recipients.
const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
const LAMPORTS_PER_SOL = 1_000_000_000n
const PAGE_SIZE = 1_000
const TRANSACTION_BATCH_SIZE = 10
const INDEX_KIND = 'pump-creator-earnings-v2'
const INDEX_SCHEMA_VERSION = 2
const runningMints = new Set()
const fastHistorySupport = new Map()

function discriminator(name) {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)
}

const CREATE_EVENT = discriminator('CreateEvent')
const PUMP_TRADE_EVENT = discriminator('TradeEvent')
const AMM_BUY_EVENT = discriminator('BuyEvent')
const AMM_SELL_EVENT = discriminator('SellEvent')

function startsWith(value, prefix) {
  return value?.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix)
}

function u64At(data, offset) {
  return data.length >= offset + 8 ? data.readBigUInt64LE(offset) : 0n
}

function timestampAt(data, offset, fallback) {
  if (data.length < offset + 8) return fallback
  const value = Number(data.readBigInt64LE(offset)) * 1_000
  return Number.isFinite(value) && value > Date.UTC(2020, 0, 1) ? value : fallback
}

function eventData(transaction) {
  const data = []
  for (const message of transaction?.meta?.logMessages ?? []) {
    if (!message.startsWith('Program data: ')) continue
    try { data.push(Buffer.from(message.slice(14), 'base64')) } catch { /* unrelated malformed data */ }
  }
  return data
}

function skipBorshString(data, offset) {
  if (data.length < offset + 4) return null
  const end = offset + 4 + data.readUInt32LE(offset)
  return end <= data.length ? end : null
}

function decodeOriginalCreator(transaction, mint) {
  for (const data of eventData(transaction)) {
    if (!startsWith(data, CREATE_EVENT)) continue
    let offset = 8
    for (let index = 0; index < 3; index += 1) {
      offset = skipBorshString(data, offset)
      if (offset === null) break
    }
    if (offset === null || data.length < offset + (32 * 4)) continue
    if (!new PublicKey(data.subarray(offset, offset + 32)).equals(mint)) continue
    // CreateEvent: mint, bonding_curve, user, creator.
    return new PublicKey(data.subarray(offset + (32 * 3), offset + (32 * 4)))
  }
  return null
}

function sharingConfigPda(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('sharing-config'), mint.toBuffer()], PUMP_FEES_PROGRAM_ID)[0]
}

function decodeSharingConfig(account) {
  if (!account?.owner.equals(PUMP_FEES_PROGRAM_ID)) return null
  const data = account.data
  // Anchor discriminator, bump, version, ConfigStatus enum, mint, admin,
  // admin_revoked, Vec<Shareholder { address, share_bps }>.
  let offset = 8 + 1 + 1 + 1 + 32 + 32 + 1
  if (data.length < offset + 4) return null
  const count = data.readUInt32LE(offset)
  offset += 4
  const shareholders = []
  for (let index = 0; index < count; index += 1) {
    if (data.length < offset + 34) return null
    shareholders.push({ address: new PublicKey(data.subarray(offset, offset + 32)), bps: data.readUInt16LE(offset + 32) })
    offset += 34
  }
  return { shareholders }
}

async function resolveOriginalCreator(connection, mint, curve, stored) {
  const known = stored?.creatorFeeIndex?.creatorAddress
  if (known) return new PublicKey(known)
  const config = sharingConfigPda(mint)
  if (!curve.creator.equals(config)) return curve.creator

  // A migrated curve points at the sharing PDA, so recover the original dev
  // from Pump's mint-specific CreateEvent-not from a wallet heuristic.
  let before
  for (let page = 0; page < 64; page += 1) {
    const signatures = await rpcWithRetry(
      () => connection.getSignaturesForAddress(curve.address, { before, limit: PAGE_SIZE }),
      'Pump creator creation history',
    )
    if (!signatures.length) break
    if (signatures.length < PAGE_SIZE) {
      for (const entry of signatures.slice(-24).reverse()) {
        const transaction = await rpcWithRetry(
          () => connection.getParsedTransaction(entry.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
          'Pump creator create transaction',
        )
        const creator = decodeOriginalCreator(transaction, mint)
        if (creator) return creator
      }
      break
    }
    before = signatures.at(-1).signature
  }
  throw new Error('Unable to identify the original Pump creator from the mint creation event')
}

function creatorFeeFromTransaction(transaction, mint, pool, originalCreator, sharingAddress, shareBps) {
  let total = 0n
  const fallbackTimestamp = transaction?.blockTime ? transaction.blockTime * 1_000 : Date.now()
  for (const data of eventData(transaction)) {
    if (startsWith(data, PUMP_TRADE_EVENT)) {
      // Pump TradeEvent: mint 8..39; creator 177..208; creator_fee 217..224.
      if (data.length < 225 || !data.subarray(8, 40).equals(mint.toBuffer())) continue
      const recipient = new PublicKey(data.subarray(177, 209))
      const fee = u64At(data, 217)
      if (recipient.equals(originalCreator)) total += fee
      else if (sharingAddress && recipient.equals(sharingAddress)) total += fee * BigInt(shareBps) / 10_000n
      continue
    }
    if (startsWith(data, AMM_BUY_EVENT) || startsWith(data, AMM_SELL_EVENT)) {
      // PumpSwap Buy/SellEvent: pool 120..151; coin_creator 312..343;
      // coin_creator_fee 352..359. LP and protocol fees are ignored.
      if (data.length < 360 || !pool || !data.subarray(120, 152).equals(pool.toBuffer())) continue
      const recipient = new PublicKey(data.subarray(312, 344))
      const fee = u64At(data, 352)
      if (recipient.equals(originalCreator)) total += fee
      else if (sharingAddress && recipient.equals(sharingAddress)) total += fee * BigInt(shareBps) / 10_000n
    }
  }
  return { fee: total, timestamp: fallbackTimestamp }
}

function emptyIndex(creatorAddress, shareBps) {
  return {
    kind: INDEX_KIND,
    indexSchemaVersion: INDEX_SCHEMA_VERSION,
    creatorAddress: creatorAddress.toBase58(),
    creatorShareBps: shareBps,
    phase: 'indexing',
    targetIndex: 0,
    cursor: null,
    targets: [],
    // One durable newest transaction marker per Pump venue. These let the
    // ten-second refresh inspect only the small head of each history after
    // the one-time backfill has completed.
    targetMarkers: {},
    lifetimeCreatorFeesLamports: '0',
    todayCreatorFeesLamports: '0',
    todayStartUtcMs: easternMidnightUtcMs(),
    transactionsScanned: 0,
    updatedAt: Date.now(),
  }
}

function markerFor(transaction) {
  const signature = transaction?.signature
    ?? transaction?._surviveSignature
    ?? transaction?.transaction?.signatures?.[0]
  const slot = Number(transaction?.slot)
  return typeof signature === 'string' && Number.isFinite(slot) ? { signature, slot } : null
}

function newerMarker(current, candidate) {
  if (!candidate) return current
  return !current || candidate.slot > current.slot ? candidate : current
}

function stats(index) {
  if (!index || index.kind !== INDEX_KIND || index.indexSchemaVersion !== INDEX_SCHEMA_VERSION || index.phase !== 'ready') {
    return {
      creatorAddress: index?.creatorAddress ?? null,
      creatorShareBps: index?.creatorShareBps ?? null,
      claimedCreatorFeesSol: null,
      unclaimedCreatorFeesSol: null,
      lifetimeCreatorFeesSol: null,
      todayCreatorFeesSol: null,
      feeSource: null,
    }
  }
  const lifetime = BigInt(index.lifetimeCreatorFeesLamports)
  const today = BigInt(index.todayCreatorFeesLamports)
  return {
    creatorAddress: index.creatorAddress,
    creatorShareBps: index.creatorShareBps,
    // Per-mint trade events are the exact accounting boundary. Pump vaults
    // are keyed by creator, not mint, so their balances/claims can include
    // other coins and must never be mixed into this token's balance.
    claimedCreatorFeesSol: null,
    unclaimedCreatorFeesSol: null,
    lifetimeCreatorFeesSol: Number(lifetime) / Number(LAMPORTS_PER_SOL),
    todayCreatorFeesSol: Number(today) / Number(LAMPORTS_PER_SOL),
    feeSource: 'pump-mint-creator-fee-index',
  }
}

function historyTargets(curve, pool) {
  return curve.complete ? [curve.address, pool] : [curve.address]
}

function isFastHistoryUnavailable(error) {
  return /method not found|not supported|forbidden|403|plan|unavailable/i.test(error?.message ?? '')
}

async function fetchHistoryPage(connection, rpcUrl, target, cursor) {
  if (fastHistorySupport.get(rpcUrl) !== false) {
    try {
      const response = await getHeliusTransactionsForAddress(rpcUrl, target.toBase58(), {
        sortOrder: 'asc',
        ...(cursor ? { paginationToken: cursor } : {}),
      })
      fastHistorySupport.set(rpcUrl, true)
      return { transactions: Array.isArray(response?.data) ? response.data : [], cursor: response?.paginationToken ?? null }
    } catch (error) {
      if (!isFastHistoryUnavailable(error)) throw error
      fastHistorySupport.set(rpcUrl, false)
    }
  }
  const signatures = await rpcWithRetry(
    () => connection.getSignaturesForAddress(target, { before: cursor ?? undefined, limit: PAGE_SIZE }),
    'Creator-fee transaction history',
  )
  const fetchable = signatures.filter((entry) => !entry.err)
  const transactions = []
  for (let start = 0; start < fetchable.length; start += TRANSACTION_BATCH_SIZE) {
    const entries = fetchable.slice(start, start + TRANSACTION_BATCH_SIZE)
    const batch = await initialIndexBatchRpc(
      () => connection.getTransactions(entries.map((entry) => entry.signature), { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
      entries.length,
      'Creator-fee transaction batch',
    )
    for (let index = 0; index < batch.length; index += 1) {
      const transaction = batch[index]
      // Standard RPC omits a signature from getTransaction. Retain the
      // signature-list context solely as an internal durable cursor.
      if (transaction) transactions.push({ ...transaction, _surviveSignature: entries[index].signature })
    }
  }
  return { transactions, cursor: signatures.length === PAGE_SIZE ? signatures.at(-1).signature : null }
}

async function fetchRecentHistoryPage(connection, rpcUrl, target, marker, cursor) {
  if (fastHistorySupport.get(rpcUrl) !== false) {
    try {
      const response = await getHeliusTransactionsForAddress(rpcUrl, target.toBase58(), {
        sortOrder: 'desc',
        ...(cursor ? { paginationToken: cursor } : {}),
      })
      fastHistorySupport.set(rpcUrl, true)
      return { transactions: Array.isArray(response?.data) ? response.data : [], cursor: response?.paginationToken ?? null }
    } catch (error) {
      if (!isFastHistoryUnavailable(error)) throw error
      fastHistorySupport.set(rpcUrl, false)
    }
  }
  const signatures = await rpcWithRetry(
    () => connection.getSignaturesForAddress(target, {
      ...(cursor ? { before: cursor } : {}),
      until: marker.signature,
      limit: PAGE_SIZE,
    }),
    'Creator-fee catch-up history',
  )
  const fetchable = signatures.filter((entry) => !entry.err)
  const transactions = []
  for (let start = 0; start < fetchable.length; start += TRANSACTION_BATCH_SIZE) {
    const entries = fetchable.slice(start, start + TRANSACTION_BATCH_SIZE)
    const batch = await initialIndexBatchRpc(
      () => connection.getTransactions(entries.map((entry) => entry.signature), { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
      entries.length,
      'Creator-fee catch-up batch',
    )
    for (let index = 0; index < batch.length; index += 1) {
      if (batch[index]) transactions.push({ ...batch[index], _surviveSignature: entries[index].signature })
    }
  }
  return { transactions, cursor: signatures.length === PAGE_SIZE ? signatures.at(-1).signature : null }
}

async function catchUpReadyIndex({ connection, rpcUrl, mintAddress, stored, index, mint, pool, targets, originalCreator, sharingAddress, shareBps, easternStart }) {
  const markers = { ...(index.targetMarkers ?? {}) }
  // Older persisted v2 indexes have no per-venue cursor. Do one safe
  // backfill rather than risking a duplicate lifetime balance.
  if (!targets.every((target) => markers[target.toBase58()]?.signature)) {
    index.phase = 'indexing'
    index.targetIndex = 0
    index.cursor = null
    index.lifetimeCreatorFeesLamports = '0'
    index.todayCreatorFeesLamports = '0'
    index.transactionsScanned = 0
    index.targetMarkers = {}
    await writeMintIndex(mintAddress, { ...stored, creatorFeeIndex: index })
    return index
  }

  let lifetime = BigInt(index.lifetimeCreatorFeesLamports)
  // A token launched today needs no second accounting pass: all of its
  // lifetime creator fees are today's Eastern-calendar fees.
  const createdToday = Number.isFinite(stored.creationTimestamp)
    && stored.creationTimestamp >= easternStart
  let today = index.todayStartUtcMs === easternStart
    ? BigInt(index.todayCreatorFeesLamports)
    : (createdToday ? lifetime : 0n)
  const seen = new Set()

  for (const target of targets) {
    const targetKey = target.toBase58()
    const marker = markers[targetKey]
    let cursor = null
    let newest = null
    let reachedMarker = false
    // Four enhanced-history pages is a bounded ten-second catch-up. In a
    // burst, a later poll continues from the existing marker rather than
    // blocking every visitor or replaying lifetime history.
    for (let pageNumber = 0; pageNumber < 4 && !reachedMarker; pageNumber += 1) {
      const page = await fetchRecentHistoryPage(connection, rpcUrl, target, marker, cursor)
      for (const transaction of page.transactions) {
        const current = markerFor(transaction)
        if (!current) continue
        newest = newerMarker(newest, current)
        if (current.signature === marker.signature || current.slot <= marker.slot) {
          reachedMarker = true
          break
        }
        if (seen.has(current.signature)) continue
        seen.add(current.signature)
        const event = creatorFeeFromTransaction(transaction, mint, pool, originalCreator, sharingAddress, shareBps)
        lifetime += event.fee
        if (event.timestamp >= easternStart) today += event.fee
        index.transactionsScanned = (index.transactionsScanned ?? 0) + 1
      }
      cursor = page.cursor
      if (!reachedMarker && !cursor) {
        // A missing old marker means the provider pruned it. Leave the
        // existing aggregate intact and retry via a future full repair
        // instead of publishing a potentially duplicated total.
        throw new Error(`Creator-fee cursor unavailable for ${targetKey}`)
      }
    }
    if (!reachedMarker) return index
    if (newest) markers[targetKey] = newest
  }

  index.targetMarkers = markers
  index.lifetimeCreatorFeesLamports = lifetime.toString()
  index.todayCreatorFeesLamports = today.toString()
  index.todayStartUtcMs = easternStart
  index.updatedAt = Date.now()
  await writeMintIndex(mintAddress, { ...stored, creatorFeeIndex: index })
  return index
}

async function indexOneChunk(connection, rpcUrl, mintAddress) {
  const mint = new PublicKey(mintAddress)
  const stored = (await readMintIndex(mintAddress)) ?? {}
  const curve = await getPumpBondingCurve(connection, mintAddress)
  if (!curve) throw new Error('Configured mint has no official Pump bonding curve')
  const sharingAddress = sharingConfigPda(mint)
  const sharing = decodeSharingConfig(await rpcWithRetry(
    () => connection.getAccountInfo(sharingAddress),
    'Pump sharing-config read',
  ))
  const originalCreator = await resolveOriginalCreator(connection, mint, curve, stored)
  const shareBps = sharing?.shareholders.find((shareholder) => shareholder.address.equals(originalCreator))?.bps
    ?? (sharing ? 0 : 10_000)
  const pool = canonicalPumpSwapPool(mintAddress)
  const targets = historyTargets(curve, pool)
  let index = stored.creatorFeeIndex?.kind === INDEX_KIND
    && stored.creatorFeeIndex.indexSchemaVersion === INDEX_SCHEMA_VERSION
    && stored.creatorFeeIndex.creatorAddress === originalCreator.toBase58()
    ? { ...stored.creatorFeeIndex }
    : emptyIndex(originalCreator, shareBps)

  index.creatorShareBps = shareBps
  index.targets = targets.map((target) => target.toBase58())
  const easternStart = easternMidnightUtcMs()
  if (index.phase === 'ready') {
    return catchUpReadyIndex({
      connection,
      rpcUrl,
      mintAddress,
      stored,
      index,
      mint,
      pool,
      targets,
      originalCreator,
      sharingAddress: sharing ? sharingAddress : null,
      shareBps,
      easternStart,
    })
  }
  let lifetime = BigInt(index.lifetimeCreatorFeesLamports)
  let today = index.todayStartUtcMs === easternStart ? BigInt(index.todayCreatorFeesLamports) : 0n
  const markers = { ...(index.targetMarkers ?? {}) }
  const target = targets[index.targetIndex ?? 0]
  if (!target) {
    index.phase = 'ready'
  } else {
    const page = await fetchHistoryPage(connection, rpcUrl, target, index.cursor)
    for (const transaction of page.transactions) {
      const currentMarker = markerFor(transaction)
      if (currentMarker) markers[target.toBase58()] = newerMarker(markers[target.toBase58()], currentMarker)
      const event = creatorFeeFromTransaction(transaction, mint, pool, originalCreator, sharing ? sharingAddress : null, shareBps)
      lifetime += event.fee
      if (event.timestamp >= easternStart) today += event.fee
    }
    index.transactionsScanned = (index.transactionsScanned ?? 0) + page.transactions.length
    if (page.cursor) {
      index.cursor = page.cursor
      index.phase = 'indexing'
    } else {
      index.targetIndex += 1
      index.cursor = null
      index.phase = index.targetIndex >= targets.length ? 'ready' : 'indexing'
    }
  }
  index.lifetimeCreatorFeesLamports = lifetime.toString()
  index.todayCreatorFeesLamports = today.toString()
  index.todayStartUtcMs = easternStart
  index.targetMarkers = markers
  index.updatedAt = Date.now()
  await writeMintIndex(mintAddress, { ...stored, creatorFeeIndex: index })
  if (process.env.NODE_ENV !== 'production') {
    console.info(
      `[creator-fees] mint=${mintAddress} creator=${originalCreator.toBase58()} sharing=${Boolean(sharing)} `
      + `shareBps=${shareBps} scanned=${index.transactionsScanned} phase=${index.phase} `
      + `lifetime=${Number(lifetime) / 1e9} SOL`,
    )
  }
  return index
}

export async function getPumpCreatorFeeStats(connection, mintAddress, rpcUrl) {
  const stored = (await readMintIndex(mintAddress)) ?? {}
  const immediate = stats(stored.creatorFeeIndex)
  if (!runningMints.has(mintAddress)) {
    runningMints.add(mintAddress)
    void indexOneChunk(connection, rpcUrl, mintAddress)
      .then((index) => {
        if (index.phase === 'indexing') {
          setTimeout(() => { void getPumpCreatorFeeStats(connection, mintAddress, rpcUrl) }, 0)
        }
      })
      .catch((error) => {
        if (process.env.NODE_ENV !== 'production') console.warn(`[creator-fees:error] mint=${mintAddress} ${error.message}`)
      })
      .finally(() => runningMints.delete(mintAddress))
  }
  return immediate
}
