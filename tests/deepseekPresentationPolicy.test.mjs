import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  applyDeepSeekUserFacingPolicy,
  DEEPSEEK_USER_FACING_POLICY
} from '../server/lib/deepseekPresentation.js'

test('DeepSeek presentation policy forbids process narration and converts process to conclusions', () => {
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /must not narrate your process/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /first-person statements about what you read, checked, searched, inspected, verified/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /fresh, newly read, live-verified, or not taken from memory/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /pagination, page numbers, page sizes, batches/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /updatedAt values/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /read-only, that nothing was written/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /State facts as conclusions, not as actions you performed/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /The library contains 102 entries; no entries are missing or invalid/
  )
})

test('DeepSeek presentation policy forbids generic continuation CTAs', () => {
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /End after the last substantive finding or conclusion/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /Do not append offers to continue/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /"if you want"/
  )
  assert.match(
    DEEPSEEK_USER_FACING_POLICY,
    /proposals to prepare another batch/
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
