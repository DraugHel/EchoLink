import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildConversationSnapshot,
  buildContinuationMessage,
  planSummaryGeneration,
  redactSummarySecrets,
  validateSummaryContent
} from '../server/lib/conversationSummary.js'

function conversation(overrides = {}) {
  return {
    id: 42,
    title: 'EchoLink Debug',
    model: 'openai/gpt-5.6-sol',
    system_prompt: 'bestehender prompt',
    temperature: 0.4,
    top_k: 40,
    top_p: 0.9,
    reasoning_effort: 'high',
    ...overrides
  }
}

test('snapshot redacts obvious secrets, excludes reasoning and hashes older edits/settings', () => {
  const rows = [
    {
      id: 10,
      role: 'user',
      content: 'key=sk-abcdefghijklmnopqrstuvwxyz1234',
      images: JSON.stringify([{ filename: 'log.txt', originalName: 'log.txt', size: 12, kind: 'file' }]),
      think: 'must never be included',
      created_at: 1
    },
    { id: 11, role: 'assistant', content: '**Terminal:** npm test -> ok', images: '', think: 'hidden', created_at: 2 }
  ]

  const first = buildConversationSnapshot(conversation(), rows)
  assert.equal(first.sourceMessageCount, 2)
  assert.match(first.messages[0].content, /REDACTED_API_KEY/)
  assert.doesNotMatch(JSON.stringify(first), /must never|hidden/)
  assert.match(first.messages[1].content, /Terminal/)

  const edited = buildConversationSnapshot(conversation(), [
    { ...rows[0], content: 'geändert' },
    rows[1]
  ])
  assert.notEqual(edited.sourceHash, first.sourceHash)

  const secretOnlyEdit = buildConversationSnapshot(conversation(), [
    { ...rows[0], content: 'key=sk-zyxwvutsrqponmlkjihgfedcba4321' },
    rows[1]
  ])
  assert.match(secretOnlyEdit.messages[0].content, /REDACTED_API_KEY/)
  assert.notEqual(secretOnlyEdit.sourceHash, first.sourceHash)

  const settingsChanged = buildConversationSnapshot(
    conversation({ reasoning_effort: 'low' }),
    rows
  )
  assert.notEqual(settingsChanged.sourceHash, first.sourceHash)
})

test('secret redaction covers bearer tokens and signed URL query values', () => {
  const value = redactSummarySecrets(
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz https://x.test/a?X-Amz-Signature=abc123&token=secretvalue'
  )
  assert.match(value, /Bearer \[REDACTED_TOKEN\]/)
  assert.match(value, /X-Amz-Signature=\[REDACTED\]/)
  assert.match(value, /token=\[REDACTED\]/)

  const imageData = redactSummarySecrets(
    `before data:image/png;base64,${'A'.repeat(400)} after`
  )
  assert.match(imageData, /OMITTED_BINARY_DATA_URI/)
  assert.doesNotMatch(imageData, /A{100}/)
})

test('evidence IDs must belong to the frozen source snapshot', () => {
  const snapshot = buildConversationSnapshot(conversation(), [
    { id: 101, role: 'user', content: 'A', images: '', created_at: 1 },
    { id: 102, role: 'assistant', content: 'B', images: '', created_at: 2 }
  ])
  assert.equal(validateSummaryContent('Bestätigt [Nachricht 102]', snapshot), 'Bestätigt [Nachricht 102]')
  assert.throws(
    () => validateSummaryContent('Erfunden [Nachricht 999]', snapshot),
    error => error.code === 'SUMMARY_INVALID_EVIDENCE'
  )
})

test('long conversations are chunked chronologically without losing message IDs', () => {
  const rows = Array.from({ length: 18 }, (_, index) => ({
    id: index + 1,
    role: index % 2 ? 'assistant' : 'user',
    content: `${index}: ${'x'.repeat(2300)}`,
    images: '',
    created_at: index + 1
  }))
  const snapshot = buildConversationSnapshot(conversation({ model: 'small-32k' }), rows)
  const plan = planSummaryGeneration(snapshot, 'plain-model', {
    CHAT_CONTEXT_DEFAULT_INPUT_TOKENS: '8000',
    CHAT_CONTEXT_CHARS_PER_TOKEN: '3.2',
    CONVERSATION_SUMMARY_OUTPUT_TOKENS: '2000',
    CONVERSATION_SUMMARY_PART_OUTPUT_TOKENS: '512'
  })

  assert.equal(plan.mode, 'chunked')
  assert.ok(plan.calls >= 2 && plan.calls <= 9)
  const covered = plan.chunks.flat().map(message => message.id)
  for (const row of rows) assert.ok(covered.includes(row.id), `message ${row.id} must be covered`)
  assert.deepEqual([...new Set(covered)].sort((a, b) => a - b), rows.map(row => row.id))
})

test('too-large jobs are rejected before a provider call would be needed', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    role: index % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(7000),
    images: '',
    created_at: index + 1
  }))
  const snapshot = buildConversationSnapshot(conversation(), rows)
  assert.throws(
    () => planSummaryGeneration(snapshot, 'plain-model', {
      CHAT_CONTEXT_DEFAULT_INPUT_TOKENS: '8000',
      CHAT_CONTEXT_CHARS_PER_TOKEN: '3.2',
      CONVERSATION_SUMMARY_OUTPUT_TOKENS: '2000',
      CONVERSATION_SUMMARY_PART_OUTPUT_TOKENS: '512'
    }),
    error => error.code === 'SUMMARY_TOO_LARGE'
  )
})

test('continuation message is historical context and does not claim attachments are present', () => {
  const snapshot = buildConversationSnapshot(conversation(), [
    { id: 1, role: 'user', content: 'Datei foo.pdf', images: '', created_at: 1 }
  ])
  const message = buildContinuationMessage(snapshot, '## Aktueller Stand\nTest [Nachricht 1]')
  assert.match(message, /historischer Kontext/)
  assert.match(message, /nicht automatisch angehängt/)
  assert.match(message, /Quellchat #42/)
})
