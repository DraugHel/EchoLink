import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  ZAI_MODELS_URL,
  normalizeZaiModels,
  zaiRequestExtras
} from '../server/providers/openai-compatible.js'

test('Z.ai uses the General API models endpoint', () => {
  assert.equal(
    ZAI_MODELS_URL,
    'https://api.z.ai/api/paas/v4/models'
  )
})

test('Z.ai model discovery is dynamic and accepts future GLM versions', () => {
  const models = normalizeZaiModels({
    data: [
      { id: 'glm-5.3' },
      { id: 'glm-5.3-flash' },
      { id: 'glm-5.4' },
      { id: 'glm-5.4-air' }
    ]
  })

  assert.deepEqual(
    new Set(models.map(model => model.name)),
    new Set([
      'zai/glm-5.3',
      'zai/glm-5.3-flash',
      'zai/glm-5.4',
      'zai/glm-5.4-air'
    ])
  )
  assert.ok(models.every(model => model.provider === 'zai'))
})

test('Z.ai model discovery accepts common response shapes and deduplicates', () => {
  const models = normalizeZaiModels({
    models: [
      'glm-5.3',
      { name: 'glm-5.3' },
      { model: 'glm-5.2' }
    ]
  })

  assert.equal(models.length, 2)
  assert.ok(models.some(model => model.name === 'zai/glm-5.3'))
  assert.ok(models.some(model => model.name === 'zai/glm-5.2'))
})

test('Z.ai model discovery does not invent or hardcode models', () => {
  assert.deepEqual(normalizeZaiModels({ data: [] }), [])
  assert.deepEqual(normalizeZaiModels({}), [])
})

test('chat model list has no hardcoded zai/glm model IDs', () => {
  const source = fs.readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )

  assert.doesNotMatch(source, /['"]zai\/glm-/)
  assert.match(source, /ZAI_MODELS_URL/)
  assert.match(source, /normalizeZaiModels/)
})

test('GLM 5.3 family always keeps thinking enabled', () => {
  assert.deepEqual(
    zaiRequestExtras('glm-5.3', 'off'),
    {
      thinking: { type: 'enabled' },
      reasoning_effort: 'low'
    }
  )

  assert.deepEqual(
    zaiRequestExtras('glm-5.3-flash', 'max'),
    {
      thinking: { type: 'enabled' },
      reasoning_effort: 'max'
    }
  )

  assert.deepEqual(
    zaiRequestExtras('glm-5.3-future-variant', 'medium'),
    {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    }
  )
})

test('older Z.ai models retain their previous thinking-off behavior', () => {
  assert.deepEqual(
    zaiRequestExtras('glm-5.2', 'off'),
    { thinking: { type: 'disabled' } }
  )
  assert.deepEqual(
    zaiRequestExtras('glm-5.2', 'high'),
    {}
  )
})
