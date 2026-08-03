import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { runDeepSeekMemory } from '../server/lib/deepseekMemory.js'

const DEEPSEEK_URL =
  'https://api.deepseek.com/chat/completions'

function okResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  }
}

test('DeepSeek-Routing: nutzt DeepSeek-URL, nie Ollama; Präfix wird gestrippt', async () => {
  let calledUrl = null
  let calledBody = null

  const fetchImpl = async (url, options) => {
    calledUrl = url
    calledBody = JSON.parse(options.body)
    return okResponse({
      choices: [
        { message: { content: ' ergebnis ' } }
      ]
    })
  }

  const out = await runDeepSeekMemory({
    model: 'deepseek/deepseek-v4-flash',
    prompt: 'test',
    apiKey: 'sk-test',
    fetchImpl
  })

  assert.equal(calledUrl, DEEPSEEK_URL)
  assert.ok(
    !calledUrl.includes('11434'),
    'Ollama darf bei DeepSeek nie aufgerufen werden'
  )
  assert.equal(
    calledBody.model,
    'deepseek-v4-flash'
  )
  assert.equal(out, 'ergebnis')
})

test('API-Key wird als Bearer-Header gesendet', async () => {
  let auth = null

  const fetchImpl = async (_url, options) => {
    auth = options.headers.Authorization
    return okResponse({
      choices: [
        { message: { content: 'ok' } }
      ]
    })
  }

  await runDeepSeekMemory({
    model: 'deepseek/deepseek-v4-flash',
    prompt: 'p',
    apiKey: 'sk-geheim',
    fetchImpl
  })

  assert.equal(auth, 'Bearer sk-geheim')
})

test('Thinking ist deaktiviert (deterministische Extraktion)', async () => {
  let body = null

  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body)
    return okResponse({
      choices: [
        { message: { content: 'ok' } }
      ]
    })
  }

  await runDeepSeekMemory({
    model: 'deepseek/deepseek-v4-flash',
    prompt: 'p',
    apiKey: 'sk-test',
    fetchImpl
  })

  assert.deepEqual(
    body.thinking,
    { type: 'disabled' }
  )
})

test('Erfolgreiche Antwort wird als Text extrahiert', async () => {
  const out = await runDeepSeekMemory({
    model: 'deepseek-v4-flash',
    prompt: 'p',
    apiKey: 'sk-test',
    fetchImpl: async () => okResponse({
      choices: [
        {
          message: {
            content: '   saubere Antwort   '
          }
        }
      ]
    })
  })

  assert.equal(out, 'saubere Antwort')
})

test('API-Fehler wirft Error mit Status und Meldung', async () => {
  await assert.rejects(
    runDeepSeekMemory({
      model: 'deepseek/deepseek-v4-flash',
      prompt: 'p',
      apiKey: 'sk-test',
      fetchImpl: async () => okResponse(
        {
          error: {
            message: 'model not found'
          }
        },
        400
      )
    }),
    /DeepSeek Memory 400: model not found/
  )
})

test('Fehlender API-Key wirft Error', async () => {
  await assert.rejects(
    runDeepSeekMemory({
      model: 'deepseek/deepseek-v4-flash',
      prompt: 'p',
      apiKey: ''
    }),
    /DEEPSEEK_API_KEY fehlt/
  )
})

test('memory.js hat den deepseek/-Zweig vor dem Ollama-Fallback', () => {
  const src = readFileSync(
    'server/routes/memory.js',
    'utf8'
  )

  assert.ok(
    src.includes(
      "import { runDeepSeekMemory } from '../lib/deepseekMemory.js'"
    ),
    'runDeepSeekMemory-Import fehlt'
  )

  const deepseekIdx =
    src.indexOf("selectedModel.startsWith('deepseek/')")
  const ollamaIdx =
    src.indexOf("selectedModel.startsWith('ollama/')")

  assert.ok(
    deepseekIdx !== -1,
    'DeepSeek-Zweig fehlt in runMemoryModel'
  )
  assert.ok(
    ollamaIdx !== -1,
    'Ollama-Zweig fehlt (Testvoraussetzung)'
  )
  assert.ok(
    deepseekIdx < ollamaIdx,
    'DeepSeek-Zweig muss VOR dem Ollama-Fallback stehen'
  )
})

test('Memory-Module haben gültige Syntax', () => {
  for (const file of [
    'server/routes/memory.js',
    'server/lib/deepseekMemory.js'
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
