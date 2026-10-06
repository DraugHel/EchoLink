// Tagesplan fuer Luna: wann sie sich heute von sich aus meldet.
// Reine Funktionen ohne Datenbank, damit sie sich testen lassen.

export const HARD_MAX_PER_DAY = 8
export const MISSED_GRACE_SECONDS = 45 * 60

const formatterCache = new Map()

function dateTimeFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone)

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatterCache.set(timeZone, formatter)
  }

  return formatter
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
    return typeof timeZone === 'string' && timeZone.length > 0
  } catch {
    return false
  }
}

function zonedParts(epochMs, timeZone) {
  const parts = {}

  for (const part of dateTimeFormatter(timeZone).formatToParts(
    new Date(epochMs)
  )) {
    parts[part.type] = part.value
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second)
  }
}

function offsetMinutes(epochMs, timeZone) {
  const whole = Math.floor(epochMs / 1000) * 1000
  const parts = zonedParts(whole, timeZone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )

  return (asUtc - whole) / 60000
}

export function localDateString(epochSeconds, timeZone) {
  const parts = zonedParts(epochSeconds * 1000, timeZone)

  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-')
}

export function parseClock(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
    String(value || '')
  )

  return match
    ? Number(match[1]) * 60 + Number(match[2])
    : null
}

// Lokale Uhrzeit (HH:MM) an einem lokalen Datum (YYYY-MM-DD) als Unix-Sekunden.
export function zonedTimeToEpoch(dateString, clock, timeZone) {
  const [year, month, day] = dateString.split('-').map(Number)
  const minutes = parseClock(clock)

  if (minutes === null) {
    throw new Error(`Ungueltige Uhrzeit: ${clock}`)
  }

  const guess = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutes / 60),
    minutes % 60
  )

  // Zweimal angleichen, damit auch Tage mit Zeitumstellung stimmen.
  let epoch = guess - offsetMinutes(guess, timeZone) * 60000
  epoch = guess - offsetMinutes(epoch, timeZone) * 60000

  return Math.floor(epoch / 1000)
}

export function randomInt(min, max, rng = Math.random) {
  const low = Math.ceil(Math.min(min, max))
  const high = Math.floor(Math.max(min, max))

  return low + Math.floor(rng() * (high - low + 1))
}

// Wuerfelt die Anzahl (min..max) und verteilt die Zeitpunkte zufaellig im
// Fenster. Zwischen zwei Meldungen liegt mindestens minGapMinutes.
export function buildDailyPlan({
  dateString,
  timeZone,
  windowStart,
  windowEnd,
  minPerDay,
  maxPerDay,
  minGapMinutes,
  nowSeconds,
  rng = Math.random
}) {
  const startEpoch = zonedTimeToEpoch(dateString, windowStart, timeZone)
  const endEpoch = zonedTimeToEpoch(dateString, windowEnd, timeZone)
  const from = Math.max(startEpoch, Math.floor(nowSeconds) + 60)
  const span = endEpoch - from
  const gap = Math.max(0, Math.floor(minGapMinutes)) * 60
  const low = Math.max(0, Math.min(minPerDay, HARD_MAX_PER_DAY))
  const high = Math.max(
    low,
    Math.min(maxPerDay, HARD_MAX_PER_DAY)
  )

  let count = randomInt(low, high, rng)

  // Passt die Anzahl nicht mehr in den Rest des Tages, wird sie kleiner.
  while (count > 0 && (count - 1) * gap > span) {
    count -= 1
  }

  if (count === 0 || span <= 0) {
    return { count: 0, times: [], from, to: endEpoch }
  }

  const free = span - (count - 1) * gap
  const offsets = Array.from(
    { length: count },
    () => Math.floor(rng() * (free + 1))
  ).sort((left, right) => left - right)

  return {
    count,
    times: offsets.map(
      (offset, index) => from + offset + index * gap
    ),
    from,
    to: endEpoch
  }
}

// Geplante Zeitpunkte werden der Reihe nach abgearbeitet. Zu alte werden
// als verpasst verworfen, damit Luna nie verspaetet nachts aktiv wird.
export function nextSlotState({
  times,
  nextIndex,
  nowSeconds,
  graceSeconds = MISSED_GRACE_SECONDS
}) {
  let index = Math.max(0, Number(nextIndex) || 0)
  let missed = 0

  while (
    index < times.length &&
    nowSeconds > times[index] + graceSeconds
  ) {
    missed += 1
    index += 1
  }

  return {
    missed,
    due: index < times.length && nowSeconds >= times[index],
    nextIndex: index
  }
}
