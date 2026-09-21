import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  applyDeepSeekUserFacingPolicy,
  DEEPSEEK_USER_FACING_POLICY
} from '../server/lib/deepseekPresentation.js'

test('DeepSeek presentation policy hides process provenance', () => {
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /freshly read, re-read, verified live, or not taken from memory/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /pagination, page numbers, page sizes, batch counts/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /updatedAt values/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /read-only or that nothing was written/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /generic offers/
  )
})

test('DeepSeek policy is injected into the primary system message without mutating input', () => {
  const messages = [
    {
      role: 'system',
      content: 'Base system prompt'
    },
    {
      role: 'user',
      content: 'Check the library'
    }
  ]

  const result = applyDeepSeekUserFacingPolicy(
    messages,
    'deepseek/deepseek-v4-flash'
  )

  assert.notEqual(result, messages)
  assert.equal(
    messages[0].content,
    'Base system prompt'
  )
  assert.match(
    result[0].content,
    /Base system prompt/
  )
  assert.match(
    result[0].content,
    /\[DeepSeek user-facing response policy\]/
  )
})

test('DeepSeek policy is idempotent', () => {
  const once = applyDeepSeekUserFacingPolicy(
    [{ role: 'system', content: 'Base' }],
    'deepseek/deepseek-flash'
  )
  const twice = applyDeepSeekUserFacingPolicy(
    once,
    'deepseek/deepseek-flash'
  )

  const matches = twice[0].content.match(
    /\[DeepSeek user-facing response policy\]/g
  )

  assert.equal(matches?.length, 1)
})

test('DeepSeek policy prepends a system message when one is missing', () => {
  const result = applyDeepSeekUserFacingPolicy(
    [{ role: 'user', content: 'Hello' }],
    'deepseek/deepseek-flash'
  )

  assert.equal(result[0].role, 'system')
  assert.match(
    result[0].content,
    /\[DeepSeek user-facing response policy\]/
  )
  assert.equal(result[1].role, 'user')
})

test('non-DeepSeek models are untouched', () => {
  const messages = [
    { role: 'system', content: 'Base' },
    { role: 'user', content: 'Hello' }
  ]

  assert.equal(
    applyDeepSeekUserFacingPolicy(
      messages,
      'openai/gpt-5.6-luna'
    ),
    messages
  )
})

test('chat injects the DeepSeek user-facing policy after active-model resolution', () => {
  const chat = fs.readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )

  assert.match(
    chat,
    /applyDeepSeekUserFacingPolicy/
  )
  assert.match(
    chat,
    /ollamaMessages = applyDeepSeekUserFacingPolicy\(\s*ollamaMessages,\s*activeModel\s*\)/
  )
})
