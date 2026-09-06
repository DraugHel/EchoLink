import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHistoryDb } from './chatHistoryTestDb.mjs'
import {
  readChatExcerpt,
  searchChatHistory
} from '../server/lib/chatHistorySearch.js'

function withDb(fn) {
  const db = makeHistoryDb()
  try { return fn(db) } finally { db.close() }
}

test('own search returns stable owned hits and excludes the current turn', () => withDb(db => {
  const result = searchChatHistory(db, 1, { query: 'Guitarix', limit: 10 }, {
    // Message 103 is the current user turn and itself contains "Guitarix".
    // Earlier owned message 102 contains the same term and must remain searchable.
    excludedMessageId: 103
  })
  assert.ok(result.results.some(hit => hit.messageId === 102))
  assert.ok(result.results.every(hit => hit.conversationId !== 20))
  assert.ok(result.results.every(hit => hit.messageId !== 103))
  assert.ok(result.results.every(hit => !String(hit.snippet).includes('fremder geheimer Text')))
}))

test('same terms owned by another user never leak text, title or timestamp', () => withDb(db => {
  const result = searchChatHistory(db, 1, { query: 'fremder geheimer Text', limit: 10 })
  assert.equal(result.results.length, 0)
}))

test('foreign conversation filters and foreign center IDs have neutral not-found errors', () => withDb(db => {
  assert.throws(
    () => searchChatHistory(db, 1, { query: 'Scarlett', conversation_id: 20 }),
    error => error.code === 'CHAT_HISTORY_NOT_FOUND' && error.statusCode === 404
  )
  assert.throws(
    () => readChatExcerpt(db, 1, { conversation_id: 10, message_id: 201 }),
    error => error.code === 'CHAT_HISTORY_NOT_FOUND' && error.statusCode === 404
  )
}))

test('archived messages are searchable by default and filterable without restore', () => withDb(db => {
  assert.equal(
    searchChatHistory(db, 1, { query: 'archivierten' }).results[0]?.conversationId,
    11
  )
  assert.equal(
    searchChatHistory(db, 1, { query: 'archivierten', include_archived: false }).results.length,
    0
  )
}))

test('FTS triggers reflect edits and deletes', () => withDb(db => {
  assert.ok(searchChatHistory(db, 1, { query: 'Mono Stereo' }).results.some(hit => hit.messageId === 105))
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Nun lautet die Lösung PipeWire Stereo.', 105)
  assert.equal(searchChatHistory(db, 1, { query: 'Mono Stereo' }).results.length, 0)
  assert.ok(searchChatHistory(db, 1, { query: 'PipeWire' }).results.some(hit => hit.messageId === 105))
  db.prepare('DELETE FROM messages WHERE id = ?').run(105)
  assert.equal(searchChatHistory(db, 1, { query: 'PipeWire' }).results.length, 0)
}))

test('excerpt uses actual same-chat order, keeps center and bounded attachment metadata', () => withDb(db => {
  const excerpt = readChatExcerpt(db, 1, {
    conversation_id: 10,
    message_id: 103,
    before: 2,
    after: 2
  })
  assert.deepEqual(excerpt.messages.map(message => message.id), [101, 102, 103, 104, 105])
  assert.equal(excerpt.centerMessageId, 103)
  assert.ok(excerpt.messages.find(message => message.id === 105).attachmentNames.includes('routing.png'))
  assert.ok(excerpt.messages.every(message => message.content.length <= 4000))
}))

test('long center remains present while output is truncated under a small result budget', () => withDb(db => {
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('CENTER '.repeat(2000), 103)
  const excerpt = readChatExcerpt(db, 1, {
    conversation_id: 10,
    message_id: 103,
    before: 5,
    after: 5
  }, { maxResultChars: 5000 })
  const center = excerpt.messages.find(message => message.id === 103)
  assert.ok(center)
  assert.equal(center.truncated, true)
  assert.match(center.content, /^CENTER/)
}))

test('missing FTS index is an explicit error, never an empty result', () => withDb(db => {
  db.exec('DROP TABLE message_search')
  assert.throws(
    () => searchChatHistory(db, 1, { query: 'Scarlett' }),
    error => error.code === 'CHAT_HISTORY_FTS_UNAVAILABLE'
  )
}))
