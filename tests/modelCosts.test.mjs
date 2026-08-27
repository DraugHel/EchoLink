import assert from 'node:assert/strict'
import test from 'node:test'

import {
  estimateModelUsageCost,
  providerForModel,
  resolveModelPricing
} from '../server/lib/modelCosts.js'
import {
  summarizeModelCostEntries
} from '../server/lib/modelUsageLedger.js'

test('provider inference covers every EchoLink provider family', () => {
  assert.equal(
    providerForModel('openai/gpt-5.6-luna'),
    'openai'
  )
  assert.equal(
    providerForModel('zai/glm-5.3-flash'),
    'zai'
  )
  assert.equal(
    providerForModel('deepseek/deepseek-v4-flash'),
    'deepseek'
  )
  assert.equal(
    providerForModel('kimi/kimi-k3'),
    'kimi'
  )
  assert.equal(
    providerForModel('claude-sonnet-5'),
    'anthropic'
  )
  assert.equal(
    providerForModel('llamacpp/qwen3'),
    'llamacpp'
  )
  assert.equal(
    providerForModel('qwen3:14b'),
    'ollama'
  )
  assert.equal(
    providerForModel('minimax-m3:cloud'),
    'ollama-cloud'
  )
})

test('GLM-5.3-Flash pricing accounts for cached input', () => {
  const result = estimateModelUsageCost(
    'zai/glm-5.3-flash',
    {
      promptTokens: 12314,
      cachedTokens: 11584,
      completionTokens: 879,
      totalTokens: 13193
    },
    Math.floor(
      Date.parse('2026-08-27T12:00:00Z') /
      1000
    )
  )

  assert.equal(result.priced, true)
  assert.equal(
    result.pricingKey,
    'zai:glm-5.3-flash:launch-promo-2026-08-26'
  )
  assert.ok(
    Math.abs(result.costUsd - 0.00044826) <
      1e-12
  )
})

test('OpenAI cache reads and writes use separate rates', () => {
  const result = estimateModelUsageCost(
    'openai/gpt-5.6-luna',
    {
      promptTokens: 10000,
      cachedTokens: 8000,
      cacheWriteTokens: 1000,
      completionTokens: 500
    }
  )

  assert.equal(result.priced, true)
  assert.ok(
    Math.abs(result.costUsd - 0.00121) <
      1e-12
  )
})

test('DeepSeek cache misses are billed as uncached input, not premium writes', () => {
  const result = estimateModelUsageCost(
    'deepseek/deepseek-v4-flash',
    {
      promptTokens: 100000,
      cachedTokens: 80000,
      cacheWriteTokens: 20000,
      completionTokens: 10000
    }
  )

  const expected =
    (
      80000 * 0.0028 +
      20000 * 0.14 +
      10000 * 0.28
    ) / 1_000_000

  assert.ok(
    Math.abs(result.costUsd - expected) <
      1e-12
  )
})

test('local inference is explicitly priced at zero', () => {
  const result = estimateModelUsageCost(
    'llamacpp/qwen3',
    {
      promptTokens: 500000,
      completionTokens: 50000
    }
  )

  assert.equal(result.priced, true)
  assert.equal(result.costUsd, 0)
})

test('unknown paid models stay visibly unpriced', () => {
  assert.equal(
    resolveModelPricing(
      'zai/glm-future-unknown'
    ),
    null
  )

  const result = estimateModelUsageCost(
    'zai/glm-future-unknown',
    {
      promptTokens: 1000,
      completionTokens: 100
    }
  )

  assert.equal(result.priced, false)
  assert.equal(result.costUsd, null)
})

test('summary keeps chat and memory costs separate while exposing one total', () => {
  const now = 2_000_000_000
  const summary = summarizeModelCostEntries(
    [
      {
        createdAt: now - 100,
        purpose: 'chat',
        provider: 'zai',
        priced: true,
        costUsd: 0.03
      },
      {
        createdAt: now - 200,
        purpose: 'memory',
        provider: 'zai',
        priced: true,
        costUsd: 0.004
      },
      {
        createdAt: now - 8 * 86400,
        purpose: 'chat',
        provider: 'openai',
        priced: true,
        costUsd: 0.2
      },
      {
        createdAt: now - 50,
        purpose: 'chat',
        provider: 'ollama-cloud',
        priced: false,
        costUsd: null
      }
    ],
    now
  )

  assert.ok(
    Math.abs(summary.totalUsd - 0.234) <
      1e-12
  )
  assert.ok(
    Math.abs(summary.last24hUsd - 0.034) <
      1e-12
  )
  assert.ok(
    Math.abs(summary.last7dUsd - 0.034) <
      1e-12
  )
  assert.ok(
    Math.abs(summary.chatUsd - 0.23) <
      1e-12
  )
  assert.ok(
    Math.abs(summary.memoryUsd - 0.004) <
      1e-12
  )
  assert.equal(summary.unpricedEvents, 1)
  assert.equal(summary.providers.length, 3)
})
