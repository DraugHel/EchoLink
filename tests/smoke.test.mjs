import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

const files = {
  index: path.join(root, 'server/index.js'),
  chat: path.join(root, 'server/routes/chat.js'),
  auth: path.join(root, 'server/middleware/auth.js'),
  ollama: path.join(root, 'server/providers/ollama.js'),
  anthropic: path.join(root, 'server/providers/anthropic.js'),
  compatible: path.join(
    root,
    'server/providers/openai-compatible.js'
  ),
  responses: path.join(
    root,
    'server/providers/openai-responses.js'
  ),
  playwrightClient: path.join(
    root,
    'server/lib/playwrightMcpClient.js'
  ),
  playwrightTools: path.join(
    root,
    'server/lib/playwrightTools.js'
  ),
  playwrightLauncher: path.join(
    root,
    'server/mcp/playwrightLauncher.js'
  ),
  playwrightSmoke: path.join(
    root,
    'scripts/mcp-playwright-smoke.js'
  )
}

test('wichtige Serverdateien haben gültige Syntax', () => {
  for (const [name, filename] of Object.entries(files)) {
    const result = spawnSync(
      process.execPath,
      ['--check', filename],
      {
        cwd: root,
        encoding: 'utf8'
      }
    )

    assert.equal(
      result.status,
      0,
      `${name}: ${result.stderr || result.stdout}`
    )
  }
})

test('Provider lassen sich importieren und exportieren Stream-Funktionen', async () => {
  const [
    ollama,
    anthropic,
    compatible,
    responses
  ] = await Promise.all([
    import('../server/providers/ollama.js'),
    import('../server/providers/anthropic.js'),
    import('../server/providers/openai-compatible.js'),
    import('../server/providers/openai-responses.js')
  ])

  assert.equal(typeof ollama.streamOllama, 'function')
  assert.equal(typeof anthropic.streamAnthropic, 'function')
  assert.equal(typeof compatible.streamZai, 'function')
  assert.equal(typeof compatible.splitSystemTimeNote, 'function')
  assert.equal(typeof responses.streamResponses, 'function')
  assert.equal(typeof responses.supportsReasoningConfig, 'function')
})

test('OpenAI Reasoning-Regel ist explizit statt substring-basiert', async () => {
  const responses = await import(
    '../server/providers/openai-responses.js'
  )

  assert.equal(
    responses.supportsReasoningConfig('gpt-5-chat-latest'),
    false
  )

  assert.equal(
    responses.supportsReasoningConfig('gpt-5.6'),
    true
  )

  // Das Wort "chat" irgendwo im Namen darf keine falsche Ausnahme erzeugen.
  assert.equal(
    responses.supportsReasoningConfig(
      'future-chat-capable-reasoning-model'
    ),
    true
  )
})

test('Auth-Middleware blockiert nicht angemeldete Anfragen', async () => {
  const authModule = await import('../server/middleware/auth.js')
  const requireAuth =
    authModule.requireAuth ||
    authModule.default

  assert.equal(typeof requireAuth, 'function')

  let nextCalled = false

  const response = {
    statusCode: 200,
    body: null,

    status(code) {
      this.statusCode = code
      return this
    },

    json(body) {
      this.body = body
      return this
    },

    send(body) {
      this.body = body
      return this
    },

    end() {
      return this
    }
  }

  requireAuth(
    { session: {} },
    response,
    () => {
      nextCalled = true
    }
  )

  assert.equal(nextCalled, false)
  assert.equal(response.statusCode, 401)
})

test('Auth-Middleware erlaubt angemeldete Anfragen', async () => {
  const authModule = await import('../server/middleware/auth.js')
  const requireAuth =
    authModule.requireAuth ||
    authModule.default

  let nextCalled = false

  const response = {
    status() {
      throw new Error(
        'Angemeldete Anfrage wurde unerwartet blockiert'
      )
    }
  }

  requireAuth(
    {
      session: {
        userId: 1,
        username: 'smoke-test'
      }
    },
    response,
    () => {
      nextCalled = true
    }
  )

  assert.equal(nextCalled, true)
})

test('OpenAI verwendet ausschließlich die Responses API', async () => {
  const [chatSource, responsesSource] = await Promise.all([
    readFile(files.chat, 'utf8'),
    readFile(files.responses, 'utf8')
  ])

  assert.match(
    responsesSource,
    /https:\/\/api\.openai\.com\/v1\/responses/
  )

  assert.doesNotMatch(
    responsesSource,
    /\/v1\/chat\/completions/
  )

  assert.doesNotMatch(
    chatSource,
    /\/v1\/chat\/completions/
  )

  assert.match(
    chatSource,
    /import\s*\{\s*streamResponses\s*\}[\s\S]*openai-responses\.js/
  )

  assert.match(
    chatSource,
    /activeModel\.startsWith\(['"]openai\/['"]\)/
  )

  assert.match(
    chatSource,
    /streamFn\s*=\s*streamResponses/
  )

  assert.doesNotMatch(
    chatSource,
    /async function streamResponses\s*\(/
  )
})

test('Modellliste besitzt Cache und Provider-Timeout', async () => {
  const chatSource = await readFile(files.chat, 'utf8')

  assert.match(chatSource, /MODEL_LIST_CACHE_MS/)
  assert.match(chatSource, /MODEL_PROVIDER_TIMEOUT_MS/)
  assert.match(chatSource, /Promise\.allSettled/)
  assert.match(chatSource, /X-Model-Cache/)
  assert.match(chatSource, /modelListRefreshPromise/)
})
