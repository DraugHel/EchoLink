import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  detachPendingE3ActionsForRequest,
  persistE3ApprovalCompletion,
  settleE3ActionCompletion
} from '../server/lib/e3ApprovalCompletion.js'

function createDatabase() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
    INSERT INTO conversations (id) VALUES (7);
  `)
  return db
}

function assistantMessages(db) {
  return db.prepare(`
    SELECT role, content
    FROM messages
    WHERE conversation_id = 7
    ORDER BY id
  `).all()
}

const completedResult = Object.freeze({
  conversationId: 7,
  sessionId:
    '435fbfb3-d88f-493c-8c69-9643eb102e11',
  status: 'COMPLETED',
  summary: 'E3 approval completed'
})

const formatResult = value =>
  `E3 session ${value.sessionId}\nStatus: ${value.status}`

test('Reload → Approve persists exactly one assistant completion', () => {
  const db = createDatabase()

  assert.equal(
    persistE3ApprovalCompletion({
      db,
      result: completedResult,
      formatResult
    }),
    true
  )
  assert.equal(
    persistE3ApprovalCompletion({
      db,
      result: completedResult,
      formatResult
    }),
    false
  )

  assert.deepEqual(assistantMessages(db), [{
    role: 'assistant',
    content:
      'E3 session 435fbfb3-d88f-493c-8c69-9643eb102e11\n' +
      'Status: COMPLETED'
  }])

  db.close()
})

test('disconnect detaches only the exact pending E3 request', () => {
  const pendingActions = new Map()
  const resolutions = []
  const matchingTimeout = setTimeout(
    () => {},
    60_000
  )
  const otherTimeout = setTimeout(
    () => {},
    60_000
  )
  matchingTimeout.unref?.()
  otherTimeout.unref?.()

  pendingActions.set('matching', {
    userId: 3,
    conversationId: 9,
    requestId: 'request-0001',
    sessionId:
      '123e4567-e89b-42d3-a456-426614174000',
    timeout: matchingTimeout,
    resolve: value => resolutions.push(value)
  })
  pendingActions.set('other', {
    userId: 3,
    conversationId: 9,
    requestId: 'request-0002',
    sessionId:
      '223e4567-e89b-42d3-a456-426614174000',
    timeout: otherTimeout,
    resolve: value => resolutions.push(value)
  })

  assert.equal(
    detachPendingE3ActionsForRequest({
      pendingActions,
      userId: 3,
      conversationId: 9,
      requestId: 'request-0001'
    }),
    1
  )
  assert.equal(
    pendingActions.has('matching'),
    false
  )
  assert.equal(
    pendingActions.has('other'),
    true
  )
  assert.equal(resolutions.length, 1)
  assert.match(
    resolutions[0],
    /remains READY_FOR_REVIEW/
  )

  clearTimeout(otherTimeout)
})

test('live E3 approval resumes the model without persisting an intermediate completion', () => {
  const db = createDatabase()
  const pendingActions = new Map()
  let resolved = null
  const timeout = setTimeout(() => {}, 60_000)
  timeout.unref?.()

  pendingActions.set('live-action', {
    timeout,
    isRequestActive: () => true,
    resolve: value => {
      resolved = value
    }
  })

  const outcome = settleE3ActionCompletion({
    pendingActions,
    actionId: 'live-action',
    db,
    result: completedResult,
    formatResult
  })

  assert.deepEqual(outcome, {
    continued: true,
    persisted: false
  })
  assert.equal(
    resolved,
    formatResult(completedResult)
  )
  assert.equal(pendingActions.size, 0)
  assert.deepEqual(assistantMessages(db), [])

  db.close()
})

test('detached approve or deny persists exactly once and unblocks stale state', () => {
  const db = createDatabase()
  const pendingActions = new Map()
  let resolved = null
  const timeout = setTimeout(() => {}, 60_000)
  timeout.unref?.()
  const deniedResult = {
    ...completedResult,
    status: 'DENIED'
  }

  pendingActions.set('stale-action', {
    timeout,
    isRequestActive: () => false,
    resolve: value => {
      resolved = value
    }
  })

  const first = settleE3ActionCompletion({
    pendingActions,
    actionId: 'stale-action',
    db,
    result: deniedResult,
    formatResult
  })
  const replay = settleE3ActionCompletion({
    pendingActions,
    actionId: 'stale-action',
    db,
    result: deniedResult,
    formatResult
  })

  assert.deepEqual(first, {
    continued: false,
    persisted: true
  })
  assert.deepEqual(replay, {
    continued: false,
    persisted: false
  })
  assert.equal(
    resolved,
    formatResult(deniedResult)
  )
  assert.equal(pendingActions.size, 0)
  assert.deepEqual(assistantMessages(db), [{
    role: 'assistant',
    content:
      'E3 session 435fbfb3-d88f-493c-8c69-9643eb102e11\n' +
      'Status: DENIED'
  }])

  db.close()
})
