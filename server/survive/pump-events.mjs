import { createHash } from 'node:crypto'

export const LAMPORTS_PER_SOL = 1_000_000_000n

function discriminator(name) {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)
}

const PUMP_TRADE_EVENT = discriminator('TradeEvent')
const AMM_BUY_EVENT = discriminator('BuyEvent')
const AMM_SELL_EVENT = discriminator('SellEvent')

function startsWith(buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix)
}

function u64At(buffer, offset) {
  return buffer.length >= offset + 8 ? buffer.readBigUInt64LE(offset) : 0n
}

function timestampAt(buffer, offset, fallbackMs) {
  if (buffer.length < offset + 8) return fallbackMs
  const seconds = Number(buffer.readBigInt64LE(offset))
  const timestampMs = seconds * 1_000
  return Number.isFinite(timestampMs) && timestampMs > Date.UTC(2020, 0, 1) && timestampMs <= Date.now() + 60_000
    ? timestampMs
    : fallbackMs
}

function eventDataFromLogs(logMessages) {
  const result = []
  for (const message of logMessages ?? []) {
    if (!message.startsWith('Program data: ')) continue
    try { result.push(Buffer.from(message.slice(14), 'base64')) } catch { /* unrelated malformed log */ }
  }
  return result
}

// These layouts are taken from Pump's public Pump/PumpSwap IDLs. The same
// fee components are consumed by the global-fee indexer; this module merely
// additionally exposes real trade direction and SOL amount for EVENT LOG.
export function decodePumpTradeEvents({ logMessages, mint, pool, allowUnverifiedAmm = false, fallbackTimestampMs = Date.now() }) {
  const decoded = []
  let eventIndex = 0
  for (const data of eventDataFromLogs(logMessages)) {
    if (startsWith(data, PUMP_TRADE_EVENT)) {
      if (data.length < 225) throw new Error('Malformed Pump TradeEvent')
      if (!data.subarray(8, 40).equals(mint.toBuffer())) continue
      const isBuy = data[56] !== 0
      decoded.push({
        eventIndex: eventIndex += 1,
        venue: 'pump-bonding-curve',
        type: isBuy ? 'BUY' : 'SELL',
        tone: isBuy ? 'positive' : 'negative',
        amountLamports: u64At(data, 40),
        feeLamports: u64At(data, 169) + u64At(data, 217),
        timestampMs: timestampAt(data, 89, fallbackTimestampMs),
      })
      continue
    }

    if (startsWith(data, AMM_BUY_EVENT) || startsWith(data, AMM_SELL_EVENT)) {
      if (data.length < 360) throw new Error('Malformed PumpSwap trade event')
      if (!allowUnverifiedAmm && (!pool || !data.subarray(120, 152).equals(pool.toBuffer()))) continue
      const isBuy = startsWith(data, AMM_BUY_EVENT)
      decoded.push({
        eventIndex: eventIndex += 1,
        venue: 'pumpswap',
        type: isBuy ? 'BUY' : 'SELL',
        tone: isBuy ? 'positive' : 'negative',
        // The official events expose the actual user quote transfer at 112.
        amountLamports: u64At(data, 112),
        feeLamports: u64At(data, 80) + u64At(data, 96) + u64At(data, 352),
        timestampMs: timestampAt(data, 8, fallbackTimestampMs),
      })
    }
  }
  return decoded
}

export function globalFeesFromPumpEvents(events) {
  return events.reduce((total, event) => total + event.feeLamports, 0n)
}

export function lamportsToSol(lamports) {
  return Number(lamports) / Number(LAMPORTS_PER_SOL)
}
