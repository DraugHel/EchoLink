import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HARD_MAX_PER_DAY,
  MISSED_GRACE_SECONDS,
  buildDailyPlan,
  isValidTimeZone,
  localDateString,
  nextSlotState,
  parseClock,
  zonedTimeToEpoch
} from '../server/lib/companionPlan.js'

const ZONE = 'Europe/Vienna'

function seeded(seed) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const iso = seconds => new Date(seconds * 1000).toISOString()

test('lokale Uhrzeit wird korrekt in Unix-Sekunden umgerechnet', () => {
  assert.equal(iso(zonedTimeToEpoch('2026-10-06', '08:00', ZONE)), '2026-10-06T06:00:00.000Z')
  assert.equal(iso(zonedTimeToEpoch('2026-12-01', '08:00', ZONE)), '2026-12-01T07:00:00.000Z')
})

test('Tage mit Zeitumstellung stimmen', () => {
  // Ende der Sommerzeit am 25.10.2026: 08:00 ist schon wieder MEZ (UTC+1)
  assert.equal(iso(zonedTimeToEpoch('2026-10-25', '08:00', ZONE)), '2026-10-25T07:00:00.000Z')
  // Beginn der Sommerzeit am 29.03.2026: 22:00 ist MESZ (UTC+2)
  assert.equal(iso(zonedTimeToEpoch('2026-03-29', '22:00', ZONE)), '2026-03-29T20:00:00.000Z')
})

test('das lokale Datum folgt der Zeitzone, nicht UTC', () => {
  assert.equal(
    localDateString(Date.UTC(2026, 9, 6, 22, 30) / 1000, ZONE),
    '2026-10-07'
  )
  assert.equal(
    localDateString(Date.UTC(2026, 9, 6, 21, 30) / 1000, ZONE),
    '2026-10-06'
  )
})

test('Uhrzeiten und Zeitzonen werden geprueft', () => {
  assert.equal(parseClock('08:00'), 480)
  assert.equal(parseClock('23:59'), 1439)
  for (const bad of ['24:00', '8:00', '08:60', '', null, 'abc']) {
    assert.equal(parseClock(bad), null, String(bad))
  }
  assert.equal(isValidTimeZone('Europe/Vienna'), true)
  assert.equal(isValidTimeZone('Mars/Olympus'), false)
  assert.equal(isValidTimeZone(''), false)
})

function plan(overrides = {}, seed = 1) {
  const startOfDay = zonedTimeToEpoch('2026-10-06', '07:00', ZONE)

  return buildDailyPlan({
    dateString: '2026-10-06',
    timeZone: ZONE,
    windowStart: '08:00',
    windowEnd: '22:00',
    minPerDay: 1,
    maxPerDay: 4,
    minGapMinutes: 60,
    nowSeconds: startOfDay,
    rng: seeded(seed),
    ...overrides
  })
}

test('Anzahl liegt im Bereich, Zeiten im Fenster und mit Mindestabstand', () => {
  const start = zonedTimeToEpoch('2026-10-06', '08:00', ZONE)
  const end = zonedTimeToEpoch('2026-10-06', '22:00', ZONE)
  const counts = new Set()

  for (let seed = 1; seed <= 300; seed++) {
    const result = plan({}, seed)

    counts.add(result.count)
    assert.ok(result.count >= 1 && result.count <= 4, `Anzahl ${result.count}`)
    assert.equal(result.times.length, result.count)

    for (let i = 0; i < result.times.length; i++) {
      assert.ok(result.times[i] >= start && result.times[i] <= end)
      if (i > 0) {
        assert.ok(
          result.times[i] - result.times[i - 1] >= 3600,
          'Mindestabstand verletzt'
        )
      }
    }
  }

  assert.deepEqual([...counts].sort(), [1, 2, 3, 4])
})

test('Minimum 0 erlaubt Tage ohne Meldung', () => {
  const counts = new Set()

  for (let seed = 1; seed <= 200; seed++) {
    counts.add(plan({ minPerDay: 0, maxPerDay: 2 }, seed).count)
  }

  assert.ok(counts.has(0))
  assert.ok(counts.has(2))
})

test('hartes Tageslimit gilt immer', () => {
  const result = plan({ minPerDay: 8, maxPerDay: 99, minGapMinutes: 15 })

  assert.ok(result.count <= HARD_MAX_PER_DAY)
})

test('passt die Anzahl nicht mehr in den Rest des Tages, wird sie kleiner', () => {
  // Es ist 20:30, Fenster endet 22:00, Abstand 60 Min: hoechstens 2 passen.
  const result = plan({
    minPerDay: 6,
    maxPerDay: 6,
    nowSeconds: zonedTimeToEpoch('2026-10-06', '20:30', ZONE)
  })

  assert.ok(result.count <= 2, `Anzahl ${result.count}`)
  for (const time of result.times) {
    assert.ok(time >= zonedTimeToEpoch('2026-10-06', '20:30', ZONE) + 60)
  }
})

test('nach Fensterende gibt es keine Meldungen', () => {
  const result = plan({
    nowSeconds: zonedTimeToEpoch('2026-10-06', '22:30', ZONE)
  })

  assert.equal(result.count, 0)
  assert.deepEqual(result.times, [])
})

test('gleicher Zufall ergibt gleichen Plan', () => {
  assert.deepEqual(plan({}, 7), plan({}, 7))
  assert.notDeepEqual(plan({}, 7).times, plan({}, 8).times)
})

test('Slots werden der Reihe nach faellig, verpasste verworfen', () => {
  const times = [1000, 5000, 9000]

  assert.deepEqual(
    nextSlotState({ times, nextIndex: 0, nowSeconds: 900 }),
    { missed: 0, due: false, nextIndex: 0 }
  )
  assert.deepEqual(
    nextSlotState({ times, nextIndex: 0, nowSeconds: 1000 }),
    { missed: 0, due: true, nextIndex: 0 }
  )
  assert.deepEqual(
    nextSlotState({ times, nextIndex: 1, nowSeconds: 5000 + MISSED_GRACE_SECONDS }),
    { missed: 0, due: true, nextIndex: 1 }
  )
  assert.deepEqual(
    nextSlotState({ times, nextIndex: 1, nowSeconds: 5000 + MISSED_GRACE_SECONDS + 1 }),
    { missed: 1, due: false, nextIndex: 2 }
  )
  assert.deepEqual(
    nextSlotState({ times, nextIndex: 3, nowSeconds: 99999 }),
    { missed: 0, due: false, nextIndex: 3 }
  )
})
