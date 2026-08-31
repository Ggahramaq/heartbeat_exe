const EASTERN = 'America/New_York'

function partsAt(date, timeZone) {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(values.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
}

// New York never changes UTC offset at midnight, so this works across DST
// while relying on the IANA timezone rather than a fixed Baku offset.
export function easternMidnightUtcMs(now = new Date()) {
  const local = partsAt(now, EASTERN)
  const utcGuess = Date.UTC(local.year, local.month - 1, local.day)
  const projected = partsAt(new Date(utcGuess), EASTERN)
  const projectedAsUtc = Date.UTC(projected.year, projected.month - 1, projected.day, projected.hour, projected.minute, projected.second)
  return utcGuess - (projectedAsUtc - utcGuess)
}

export function easternFeeWindow(now = new Date()) {
  return { fromUtcMs: easternMidnightUtcMs(now), toUtcMs: now.getTime(), timeZone: EASTERN }
}
