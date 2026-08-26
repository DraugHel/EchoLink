import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import {
  runZaiMemory,
  zaiMemoryRequestExtras
} from '../server/lib/zaiMemory.js'

const ZAI_URL =
  'https://api.z.ai/api/paas/v4/chat/completions'

function okResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  }
}

test('Z.ai memory uses General API and strips zai/ prefix', async () => {
  let calledUrl = null
  let calledBody = null

  const fetchImpl = async (url, options) => {
    calledUrl = url
    calledBody = JSON.parse(options.body)

    return okResponse({
      choices: [
        {
          message: {
            content: ' {"legacyMarkdown":"","memories":[]} '
          }
        }
      ]
    })
  }

  const out = await runZaiMemory({
    model: 'zai/glm-5.3-flash',
    prompt: 'test',
    apiKey: 'test-key',
    fetchImpl
  })

  assert.equal(calledUrl, ZAI_URL)
  assert.ok(
    !calledUrl.includes('11434'),
    'Ollama must never be used for zai/ memory'
  )
  assert.equal(
    calledBody.model,
    'glm-5.3-flash'
  )
  assert.equal(
    out,
    '{"legacyMarkdown":"","memories":[]}'
  )
})

test('Z.ai memory sends the configured API key as Bearer auth', async () => {
  let auth = null

  await runZaiMemory({
    model: 'zai/glm-5.3-flash',
    prompt: 'p',
    apiKey: 'zai-secret',
    fetchImpl: async (_url, options) => {
      auth = options.headers.Authorization
      return okResponse({
        choices: [
          { message: { content: '{}' } }
        ]
      })
    }
  })

  assert.equal(auth, 'Bearer zai-secret')
})

test('GLM-5.3 memory keeps thinking enabled at low effort', async () => {
  let body = null

  await runZaiMemory({
    model: 'zai/glm-5.3-flash',
    prompt: 'p',
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body)
      return okResponse({
        choices: [
          { message: { content: '{}' } }
        ]
      })
    }
  })

  assert.deepEqual(
    body.thinking,
    { type: 'enabled' }
  )
  assert.equal(
    body.reasoning_effort,
    'low'
  )
  assert.notEqual(
    body.thinking?.type,
    'disabled'
  )
})

test('all GLM-5.3 variants receive the safe memory policy', () => {
  for (const model of [
    'glm-5.3',
    'glm-5.3-flash',
    'glm-5.3-future-variant'
  ]) {
    assert.deepEqual(
      zaiMemoryRequestExtras(model),
      {
        thinking: { type: 'enabled' },
        reasoning_effort: 'low'
      }
    )
  }
})

test('other Z.ai models are not forced into an unsupported thinking mode', () => {
  assert.deepEqual(
    zaiMemoryRequestExtras('glm-5.2'),
    {}
  )
  assert.deepEqual(
    zaiMemoryRequestExtras('glm-5.4'),
    {}
  )
})

test('Z.ai memory extracts successful text responses', async () => {
  const out = await runZaiMemory({
    model: 'glm-5.3',
    prompt: 'p',
    apiKey: 'test-key',
    fetchImpl: async () => okResponse({
      choices: [
        {
          message: {
            content: '   clean response   '
          }
        }
      ]
    })
  })

  assert.equal(out, 'clean response')
})

test('Z.ai memory surfaces API errors with status and message', async () => {
  await assert.rejects(
    runZaiMemory({
      model: 'zai/glm-5.3-flash',
      prompt: 'p',
      apiKey: 'test-key',
      fetchImpl: async () => okResponse(
        {
          error: {
            message: 'bad request'
          }
        },
        400
      )
    }),
    /Z\.ai Memory 400: bad request/
  )
})

test('Z.ai memory rejects a missing API key', async () => {
  await assert.rejects(
    runZaiMemory({
      model: 'zai/glm-5.3-flash',
      prompt: 'p',
      apiKey: ''
    }),
    /ZAI_API_KEY fehlt/
  )
})

test('memory.js routes zai/ before the Ollama fallback', () => {
  const src = readFileSync(
    'server/routes/memory.js',
    'utf8'
  )

  assert.ok(
    src.includes(
      "import { runZaiMemory } from '../lib/zaiMemory.js'"
    ),
    'runZaiMemory import is missing'
  )

  const zaiIdx =
    src.indexOf("selectedModel.startsWith('zai/')")
  const ollamaIdx =
    src.indexOf("selectedModel.startsWith('ollama/')")

  assert.ok(
    zaiIdx !== -1,
    'zai/ branch is missing in runMemoryModel'
  )
  assert.ok(
    ollamaIdx !== -1,
    'Ollama branch is missing (test prerequisite)'
  )
  assert.ok(
    zaiIdx < ollamaIdx,
    'zai/ must be routed before the Ollama fallback'
  )
})

test('Z.ai memory files have valid JavaScript syntax', () => {
  for (const file of [
    'server/routes/memory.js',
    'server/lib/zaiMemory.js'
  ]) {
    const result = spawnSync(
      process.execPath,
      ['--check', file],
      { encoding: 'utf8' }
    )

    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout
    )
  }
})
