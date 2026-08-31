import { lamportsToSol } from './pump-events.mjs'

export const MAX_VISIBLE_EVENTS = 5

export function sortNewestEvents(events) {
  return [...events]
    .sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id))
}

/** Convert the canonical Pump decoder output into the public Event Log shape. */
export function normalizePumpEvents(signature, decoded) {
  const result = []
  for (const trade of decoded) {
    result.push({
      id: `${signature}:${trade.eventIndex}:trade`,
      signature,
      timestamp: trade.timestampMs,
      type: trade.type,
      tone: trade.tone,
      amountSol: lamportsToSol(trade.amountLamports),
    })
    if (trade.feeLamports > 0n) {
      result.push({
        id: `${signature}:${trade.eventIndex}:fee`,
        signature,
        timestamp: trade.timestampMs,
        type: 'FEE',
        tone: 'positive',
        amountSol: lamportsToSol(trade.feeLamports),
      })
    }
  }
  return result
}

export function newestVisibleEvents(events) {
  return sortNewestEvents(events).slice(0, MAX_VISIBLE_EVENTS)
}
