import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getLunaToolKind,
  getLunaToolText,
  normalizeLunaToolStatus
} from '../client/src/lib/lunaToolPresence.js'

test('Terminalstatus wird nicht als Kalendertermin fehlklassifiziert', () => {
  const status =
    "terminal · läuft: bash -lc 'pm2 restart echolink && pm2 status'"

  assert.equal(
    getLunaToolText(status),
    'Luna führt einen Befehl aus …'
  )
  assert.equal(getLunaToolKind(status), 'terminal')
})

test('echter Kalenderstatus bleibt Kalender', () => {
  const status = 'calendar_list_events · läuft'

  assert.equal(
    getLunaToolText(status),
    'Luna schaut in den Kalender …'
  )
  assert.equal(getLunaToolKind(status), 'calendar')
})

test('strukturierter Toolstatus wird weiterhin normalisiert', () => {
  assert.equal(
    normalizeLunaToolStatus({
      tool: 'terminal'
    }),
    'terminal'
  )
})
