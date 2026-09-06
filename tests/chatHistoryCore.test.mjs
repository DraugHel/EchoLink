import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ChatHistoryError,
  buildMessageSearchQuery,
  normalizeReadChatExcerptArgs,
  normalizeSearchChatHistoryArgs
} from '../server/lib/chatHistorySearch.js'

function code(fn) {
  try { fn() } catch (error) { return error?.code }
  return null
}

test('FTS normalization is bounded, quoted and Unicode-safe', () => {
  assert.equal(
    buildMessageSearchQuery('  Scarlett  Kopfhörer !!! '),
    '"Scarlett"* AND "Kopfhörer"*'
  )
  assert.equal(
    code(() => buildMessageSearchQuery('a b c d e f g h i j')),
    'CHAT_HISTORY_INVALID_ARGUMENTS'
  )
  assert.equal(
    buildMessageSearchQuery('Ｓｃａｒｌｅｔｔ'),
    '"Scarlett"*'
  )
})

test('search args reject coercion, unknown fields and unzoned dates', () => {
  assert.equal(
    code(() => normalizeSearchChatHistoryArgs({ query: 'Scarlett', limit: '5' })),
    'CHAT_HISTORY_INVALID_ARGUMENTS'
  )
  assert.equal(
    code(() => normalizeSearchChatHistoryArgs({ query: 'Scarlett', include_archived: 1 })),
    'CHAT_HISTORY_INVALID_ARGUMENTS'
  )
  assert.equal(
    code(() => normalizeSearchChatHistoryArgs({ query: 'Scarlett', sql: 'DROP TABLE messages' })),
    'CHAT_HISTORY_UNKNOWN_FIELD'
  )
  assert.equal(
    code(() => normalizeSearchChatHistoryArgs({ query: 'Scarlett', date_from: '2026-09-01T10:00:00' })),
    'CHAT_HISTORY_INVALID_ARGUMENTS'
  )
  const args = normalizeSearchChatHistoryArgs({
    query: 'Scarlett',
    date_from: '2026-09-01T10:00:00+02:00',
    date_to: '2026-09-02T10:00:00+02:00'
  })
  assert.equal(args.includeArchived, true)
  assert.equal(args.limit, 5)
})

test('excerpt args enforce exact integer IDs and 0..5 neighbors', () => {
  assert.deepEqual(
    normalizeReadChatExcerptArgs({ conversation_id: 10, message_id: 105 }),
    { conversationId: 10, messageId: 105, before: 3, after: 3 }
  )
  assert.throws(
    () => normalizeReadChatExcerptArgs({ conversation_id: '10', message_id: 105 }),
    ChatHistoryError
  )
  assert.equal(
    code(() => normalizeReadChatExcerptArgs({ conversation_id: 10, message_id: 105, before: 6 })),
    'CHAT_HISTORY_INVALID_ARGUMENTS'
  )
})
