import { CronExpressionParser } from 'cron-parser'

export const DEFAULT_TASK_TIMEZONE =
  process.env.DEFAULT_TASK_TIMEZONE || 'Europe/Vienna'

export const TASK_SCHEDULE_KINDS = new Set([
  'once',
  'interval',
  'cron'
])

const MAX_INTERVAL_MINUTES = 366 * 24 * 60

export function validateTimeZone(timeZone) {
  const value = String(
    timeZone || DEFAULT_TASK_TIMEZONE
  ).trim()

  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: value
    }).format(new Date())
  } catch {
    throw new Error(`Ungültige Zeitzone: ${value}`)
  }

  return value
}

export function computeNextRunAt(
  scheduleKind,
  scheduleValue,
  timeZone = DEFAULT_TASK_TIMEZONE,
  fromMs = Date.now()
) {
  const kind = String(scheduleKind || '').trim()
  const value = String(scheduleValue ?? '').trim()
  const zone = validateTimeZone(timeZone)

  if (!TASK_SCHEDULE_KINDS.has(kind)) {
    throw new Error(
      'scheduleKind muss once, interval oder cron sein'
    )
  }

  if (!value) {
    throw new Error('scheduleValue darf nicht leer sein')
  }

  if (kind === 'once') {
    const runAt = new Date(value)
    const runAtMs = runAt.getTime()

    if (!Number.isFinite(runAtMs)) {
      throw new Error(
        'Für once muss scheduleValue ein gültiger ISO-Zeitpunkt sein'
      )
    }

    if (runAtMs <= fromMs) {
      throw new Error(
        'Der einmalige Ausführungszeitpunkt muss in der Zukunft liegen'
      )
    }

    return Math.floor(runAtMs / 1000)
  }

  if (kind === 'interval') {
    const minutes = Number(value)

    if (
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > MAX_INTERVAL_MINUTES
    ) {
      throw new Error(
        `Intervall muss zwischen 1 und ${MAX_INTERVAL_MINUTES} Minuten liegen`
      )
    }

    return Math.floor(
      (fromMs + minutes * 60_000) / 1000
    )
  }

  if (value.length > 160) {
    throw new Error('Cron-Ausdruck ist zu lang')
  }

  try {
    // Immer frisch parsen. So bleiben Zeitzone und DST eindeutig.
    const expression = CronExpressionParser.parse(value, {
      currentDate: new Date(fromMs),
      tz: zone
    })

    return Math.floor(expression.next().getTime() / 1000)
  } catch (error) {
    throw new Error(
      `Ungültiger Cron-Ausdruck: ${error?.message || error}`
    )
  }
}

export function normalizeSchedule({
  scheduleKind,
  scheduleValue,
  timezone
}, fromMs = Date.now()) {
  const kind = String(scheduleKind || '').trim()
  const value = String(scheduleValue ?? '').trim()
  const zone = validateTimeZone(
    timezone || DEFAULT_TASK_TIMEZONE
  )

  const nextRunAt = computeNextRunAt(
    kind,
    value,
    zone,
    fromMs
  )

  return {
    scheduleKind: kind,
    scheduleValue: value,
    timezone: zone,
    nextRunAt
  }
}
