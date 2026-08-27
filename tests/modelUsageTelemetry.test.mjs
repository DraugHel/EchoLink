import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  runZaiMemory
} from '../server/lib/zaiMemory.js'
import {
  runDeepSeekMemory
} from '../server/lib/deepseekMemory.js'

function response(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body)
  }
}

test('Z.ai memory exposes provider usage without changing its text return contract', async () => {
  let observed = null

  const text = await runZaiMemory({
    model: 'zai/glm-5.3-flash',
    prompt: 'test',
    apiKey: 'test',
    onUsage: usage => {
      observed = usage
    },
    fetchImpl: async () => response({
      choices: [
        {
          message: {
            content:
              '{"legacyMarkdown":"","memories":[]}'
          }
        }
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: {
          cached_tokens: 64
        }
      }
    })
  })

  assert.equal(
    text,
    '{"legacyMarkdown":"","memories":[]}'
  )
  assert.equal(observed.prompt_tokens, 100)
  assert.equal(
    observed.prompt_tokens_details.cached_tokens,
    64
  )
})

test('DeepSeek memory exposes cache hit/miss usage', async () => {
  let observed = null

  const text = await runDeepSeekMemory({
    model: 'deepseek/deepseek-v4-flash',
    prompt: 'test',
    apiKey: 'test',
    onUsage: usage => {
      observed = usage
    },
    fetchImpl: async () => response({
      choices: [
        {
          message: {
            content:
              '{"legacyMarkdown":"","memories":[]}'
          }
        }
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 60,
        prompt_cache_miss_tokens: 40
      }
    })
  })

  assert.equal(
    text,
    '{"legacyMarkdown":"","memories":[]}'
  )
  assert.equal(
    observed.prompt_cache_hit_tokens,
    60
  )
  assert.equal(
    observed.prompt_cache_miss_tokens,
    40
  )
})

test('cost telemetry is wired through DB, chat, memory, system status and UI', () => {
  const db = readFileSync(
    'server/db.js',
    'utf8'
  )
  const chat = readFileSync(
    'server/routes/chat.js',
    'utf8'
  )
  const memory = readFileSync(
    'server/routes/memory.js',
    'utf8'
  )
  const system = readFileSync(
    'server/routes/system.js',
    'utf8'
  )
  const panel = readFileSync(
    'client/src/components/SystemStatusPanel.jsx',
    'utf8'
  )

  assert.match(
    db,
    /CREATE TABLE IF NOT EXISTS model_usage_events/
  )
  assert.match(
    chat,
    /cost_pricing_key/
  )
  assert.match(
    memory,
    /recordModelUsageEvent/
  )
  assert.match(
    system,
    /getModelCostSummary/
  )
  assert.match(
    panel,
    /API-Kosten/
  )
  assert.match(
    panel,
    /Nicht eingerechnet/
  )
})

test('Anthropic preserves cache reads and cache writes for billing', () => {
  const source = readFileSync(
    'server/providers/anthropic.js',
    'utf8'
  )

  assert.match(
    source,
    /cachedInputTokens/
  )
  assert.match(
    source,
    /cacheWriteTokens/
  )
  assert.match(
    source,
    /cacheObserved/
  )
})
