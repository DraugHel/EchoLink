import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CHAT_RECONNECT_RETRIES,
  attachPendingChatActions,
  chatReconnectDelayMs,
  chatReconnectingContent,
  chatStreamApplicationError,
  clearChatReconnectContent,
  removeResolvedChatAction,
  resolveChatActionRequests,
  shouldReloadResolvedE3Action
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

test('generischer OpenAI-Streamfehler nutzt den begrenzten Reconnect', () => {
  const error = chatStreamApplicationError(
    'OpenAI Responses stream error'
  )

  assert.equal(
    error.message,
    'OpenAI Responses stream error'
  )
  assert.equal(error.retryable, true)
})

test('spezifische Provider- und Anwendungsfehler bleiben nicht retryable', () => {
  assert.equal(
    chatStreamApplicationError(
      'OpenAI Responses 400: invalid_request_error'
    ).retryable,
    false
  )
  assert.equal(
    chatStreamApplicationError(
      'Max tool iterations reached'
    ).retryable,
    false
  )
})

test('Server kann einen Streamfehler explizit als retryable markieren', () => {
  const error = chatStreamApplicationError({
    message: 'temporary upstream reset',
    retryable: true
  })

  assert.equal(error.message, 'temporary upstream reset')
  assert.equal(error.retryable, true)
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

test('synthetische Approval-Bubble verschwindet vollständig nach Auflösung', () => {
  const messages = [{
    id: 'pending-action:e3-test',
    role: 'assistant',
    content: '',
    pendingActionOnly: true,
    actionRequests: [{
      actionId: 'e3-test',
      type: 'e3'
    }]
  }]

  assert.deepEqual(
    removeResolvedChatAction(
      messages,
      'e3-test'
    ),
    []
  )
})

test('nur wiederhergestellte E3-Karten laden den autoritativen Verlauf neu', () => {
  assert.equal(
    shouldReloadResolvedE3Action({
      type: 'e3',
      restored: true
    }),
    true
  )
  assert.equal(
    shouldReloadResolvedE3Action({
      type: 'e3',
      restored: false
    }),
    false
  )
  assert.equal(
    shouldReloadResolvedE3Action({
      type: 'shell',
      restored: true
    }),
    false
  )
})

test('durable E3 approval card survives message reload and disappears after resolution', () => {
  const storedMessages = [
    {
      id: 1,
      role: 'user',
      content: 'Bitte über E3 ändern'
    }
  ]
  const action = {
    actionId:
      'e3-123e4567-e89b-42d3-a456-426614174000-' +
      'a'.repeat(64) +
      '-' +
      'b'.repeat(64),
    description: 'E3 validated one operation',
    command: 'reviewed diff',
    reason: 'export only',
    type: 'e3',
    source: 'chat',
    restored: true
  }

  const restored = attachPendingChatActions(
    storedMessages,
    [action, action]
  )

  assert.equal(restored.length, 2)
  assert.equal(
    restored[1].pendingActionOnly,
    true
  )
  assert.deepEqual(
    restored[1].actionRequests,
    [action]
  )

  const resolved = attachPendingChatActions(
    storedMessages,
    []
  )

  assert.deepEqual(resolved, [
    {
      ...storedMessages[0],
      actionRequests: []
    }
  ])
})
