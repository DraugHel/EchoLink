import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { persistE3ApprovalCompletion } from '../server/lib/e3ApprovalCompletion.js'

test('Reload → Approve persists exactly one assistant completion', () => {
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

  const result = {
    conversationId: 7,
    sessionId: '435fbfb3-d88f-493c-8c69-9643eb102e11',
    status: 'COMPLETED',
    summary: 'E3 approval completed'
  }
  const formatResult = value =>
    `E3 session ${value.sessionId}\nStatus: ${value.status}`

  assert.equal(
    persistE3ApprovalCompletion({ db, result, formatResult }),
    true
  )
  assert.equal(
    persistE3ApprovalCompletion({ db, result, formatResult }),
    false
  )

  const messages = db.prepare(`
    SELECT role, content
    FROM messages
    WHERE conversation_id = 7
  `).all()
  assert.deepEqual(messages, [{
    role: 'assistant',
    content:
      'E3 session 435fbfb3-d88f-493c-8c69-9643eb102e11\n' +
      'Status: COMPLETED'
  }])

  db.close()
})
