import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CHAT_RECONNECT_RETRIES,
  chatReconnectDelayMs,
  chatReconnectingContent,
  chatStreamApplicationError,
  clearChatReconnectContent,
  resolveChatActionRequests
} from '../client/src/lib/chatReconnect.js'

test('Reconnect besitzt ein begrenztes längeres Zeitfenster', () => {
  assert.equal(MAX_CHAT_RECONNECT_RETRIES, 8)
  assert.deepEqual(
    Array.from(
      { length: MAX_CHAT_RECONNECT_RETRIES },
      (_, index) => chatReconnectDelayMs(index + 1)
    ),
    [
      1_000,
      2_000,
      4_000,
      8_000,
      10_000,
      10_000,
      10_000,
      10_000
    ]
  )
})

test('Reconnect-Hinweis verschwindet direkt nach erfolgreichem Verbindungsaufbau', () => {
  const base = 'Bisherige Antwort'
  const reconnecting = chatReconnectingContent(
    base,
    1,
    MAX_CHAT_RECONNECT_RETRIES
  )

  assert.match(reconnecting, /Reconnecting… \(1\/8\)/)
  assert.equal(
    clearChatReconnectContent(reconnecting),
    base
  )
  assert.doesNotMatch(
    clearChatReconnectContent(reconnecting),
    /Reconnecting/
  )
})

test('Providerfehler startet keinen automatischen Chat-Retry', () => {
  const error = chatStreamApplicationError(
    'OpenAI Responses stream error'
  )

  assert.equal(
    error.message,
    'OpenAI Responses stream error'
  )
  assert.equal(error.retryable, false)
})

test('erledigte Freigabe wird aus dem sichtbaren Pending-State entfernt', () => {
  const pending = [
    { actionId: 'keep', command: 'pm2 status' },
    { actionId: 'resolved', command: 'npm run deploy' }
  ]

  assert.deepEqual(
    resolveChatActionRequests(pending, 'resolved'),
    [
      { actionId: 'keep', command: 'pm2 status' }
    ]
  )
  assert.deepEqual(
    resolveChatActionRequests(undefined, 'resolved'),
    []
  )
})
