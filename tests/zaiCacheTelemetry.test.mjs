import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  normalizeOpenAICompatibleTokenUsage
} from '../server/providers/openai-compatible.js'

test('Z.ai nested cached_tokens are exposed to EchoLink cache telemetry', () => {
  const usage = normalizeOpenAICompatibleTokenUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 750 }
  })

  assert.deepEqual(usage, {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    cachedTokens: 750,
    cacheWriteTokens: 0,
    cacheObserved: true
  })
})

test('DeepSeek flat prompt-cache fields remain supported', () => {
  const usage = normalizeOpenAICompatibleTokenUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400
  })

  assert.deepEqual(usage, {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    cachedTokens: 600,
    cacheWriteTokens: 400,
    cacheObserved: true
  })
})

test('usage without cache fields does not invent cache telemetry', () => {
  const usage = normalizeOpenAICompatibleTokenUsage({
    prompt_tokens: 90,
    completion_tokens: 10,
    total_tokens: 100
  })

  assert.equal(usage.cachedTokens, 0)
  assert.equal(usage.cacheWriteTokens, 0)
  assert.equal(usage.cacheObserved, false)
})

test('missing usage stays null', () => {
  assert.equal(normalizeOpenAICompatibleTokenUsage(null), null)
})

test('provider source uses the shared usage normalizer', () => {
  const src = readFileSync(
    'server/providers/openai-compatible.js',
    'utf8'
  )

  assert.ok(src.includes(
    'normalizeOpenAICompatibleTokenUsage(usage)'
  ))
  assert.ok(src.includes(
    'usage.prompt_tokens_details?.cached_tokens'
  ))
})

test('provider file remains syntax-valid', () => {
  const result = spawnSync(
    process.execPath,
    ['--check', 'server/providers/openai-compatible.js'],
    { encoding: 'utf8' }
  )

  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout
  )
})
