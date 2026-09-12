import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getLunaToolKind,
  getLunaToolText,
  isRecoverableLunaToolEvent,
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


test('Chat-History-Suche wird im HUD nicht als Websuche klassifiziert', () => {
  for (const status of [
    'search_chat_history · läuft',
    'Frühere Chats durchsuchen · Fehler'
  ]) {
    assert.equal(
      getLunaToolText(status),
      'Luna durchsucht frühere Chats …'
    )
    assert.equal(getLunaToolKind(status), 'tool')
  }
})

test('nur der bekannte recoverable History-ID-Retry wird im HUD unterdrückt', () => {
  assert.equal(
    isRecoverableLunaToolEvent({
      tool: 'search_chat_history',
      status: 'error',
      error: 'CHAT_HISTORY_UNTRUSTED_CONVERSATION_ID'
    }),
    true
  )

  for (const event of [
    { tool: 'search_chat_history', status: 'error', error: 'CHAT_HISTORY_RUNTIME_LIMIT' },
    { tool: 'read_chat_excerpt', status: 'error', error: 'CHAT_HISTORY_UNTRUSTED_CONVERSATION_ID' },
    { tool: 'search_chat_history', status: 'done' }
  ]) {
    assert.equal(isRecoverableLunaToolEvent(event), false)
  }
})

test('Chat-History-Ausschnitt bekommt einen eigenen HUD-Text', () => {
  for (const status of [
    'read_chat_excerpt · läuft',
    'Gespräch nachlesen · fertig'
  ]) {
    assert.equal(
      getLunaToolText(status),
      'Luna liest in früheren Chats nach …'
    )
    assert.equal(getLunaToolKind(status), 'tool')
  }
})
