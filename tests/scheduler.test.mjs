import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeNextRunAt,
  normalizeSchedule,
  validateTimeZone
} from '../server/lib/scheduler.js'

test('Scheduler akzeptiert Europe/Vienna', () => {
  assert.equal(
    validateTimeZone('Europe/Vienna'),
    'Europe/Vienna'
  )
})

test('Scheduler berechnet Minutenintervalle', () => {
  const from = Date.parse('2026-07-13T00:00:00Z')

  const next = computeNextRunAt(
    'interval',
    '15',
    'Europe/Vienna',
    from
  )

  assert.equal(
    next,
    Math.floor(
      Date.parse('2026-07-13T00:15:00Z') / 1000
    )
  )
})

test('Scheduler berechnet einmaligen Zeitpunkt', () => {
  const from = Date.parse('2026-07-13T00:00:00Z')

  const next = computeNextRunAt(
    'once',
    '2026-07-13T15:00:00+02:00',
    'Europe/Vienna',
    from
  )

  assert.equal(
    next,
    Math.floor(
      Date.parse('2026-07-13T13:00:00Z') / 1000
    )
  )
})

test('Cron-Scheduler berücksichtigt Wiener Sommerzeit', () => {
  const from = Date.parse('2026-07-13T00:00:00Z')

  const next = computeNextRunAt(
    'cron',
    '0 8 * * *',
    'Europe/Vienna',
    from
  )

  assert.equal(
    next,
    Math.floor(
      Date.parse('2026-07-13T06:00:00Z') / 1000
    )
  )
})

test('Scheduler weist ungültige Cron-Ausdrücke zurück', () => {
  assert.throws(
    () => normalizeSchedule({
      scheduleKind: 'cron',
      scheduleValue: 'not a cron',
      timezone: 'Europe/Vienna'
    }),
    /Ungültiger Cron-Ausdruck/
  )
})
