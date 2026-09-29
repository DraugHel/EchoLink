import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  prepareProviderMessages,
  resolveProvider
} from '../server/providers/index.js'
import { streamOllama } from '../server/providers/ollama.js'
import { streamAnthropic } from '../server/providers/anthropic.js'
import { streamLlamaCpp } from '../server/providers/llamacpp.js'
import { streamResponses } from '../server/providers/openai-responses.js'
import {
  streamDeepSeekResponses
} from '../server/providers/deepseek-responses.js'
import {
  streamKimi,
  streamOpenAICompatible,
  streamZai
} from '../server/providers/openai-compatible.js'
import {
  fetchProviderStream,
  incompleteStreamError,
  isRetryableStatus
} from '../server/providers/streamErrors.js'

const sink = { write() { return true } }

async function withFetch(impl, run) {
  const previous = global.fetch
  global.fetch = impl
  try {
    return await run()
  } finally {
    global.fetch = previous
  }
}

function lineResponse(lines, status = 200) {
  return new Response(lines.join('\n'), { status })
}

test('ein zentraler Resolver ordnet jedes Modellpräfix zu', () => {
  const cases = [
    ['claude-sonnet-4-6', 'anthropic', 'claude-sonnet-4-6', streamAnthropic, false],
    ['zai/glm-5.2', 'zai', 'glm-5.2', streamZai, true],
    ['kimi/kimi-k3', 'kimi', 'kimi-k3', streamKimi, true],
    ['deepseek/deepseek-flash', 'deepseek', 'deepseek-flash', streamDeepSeekResponses, true],
    ['openai/gpt-5.6', 'openai', 'gpt-5.6', streamResponses, true],
    ['llamacpp/gemma', 'llamacpp', 'gemma', streamLlamaCpp, true],
    ['glm-5.1:cloud', 'ollama', 'glm-5.1:cloud', streamOllama, false]
  ]

  for (const [model, name, providerModel, streamFn, split] of cases) {
    const provider = resolveProvider(model)
    assert.equal(provider.name, name, model)
    assert.equal(provider.providerModel, providerModel, model)
    assert.equal(provider.streamFn, streamFn, model)
    assert.equal(provider.splitTimeNote, split, model)
  }
})

test('Zeithinweis wird nur für OpenAI-kompatible Provider ausgelagert', () => {
  const messages = [
    { role: 'system', content: 'Regeln\n\nCurrent date and time: Montag' },
    { role: 'user', content: 'Hallo' }
  ]

  assert.equal(
    prepareProviderMessages(resolveProvider('claude-x'), messages),
    messages
  )

  const split = prepareProviderMessages(
    resolveProvider('zai/glm-5.2'),
    messages
  )
  assert.equal(split[0].content, 'Regeln')
  assert.ok(split.some(message =>
    message.role === 'system' &&
    message.content.startsWith('Current date and time:')
  ))
  assert.equal(
    messages[0].content,
    'Regeln\n\nCurrent date and time: Montag'
  )
})

test('nur vorübergehende HTTP-Status sind wiederholbar', () => {
  for (const status of [408, 429, 500, 503, 529]) {
    assert.equal(isRetryableStatus(status), true, String(status))
  }
  for (const status of [400, 401, 404]) {
    assert.equal(isRetryableStatus(status), false, String(status))
  }
})

test('fetchProviderStream stuft Netzwerk-, Server- und Clientfehler richtig ein', async () => {
  await withFetch(async () => { throw new TypeError('fetch failed') }, async () => {
    await assert.rejects(
      fetchProviderStream('https://x.test', {}, 'Test'),
      error => error.retryable === true && error.partialOutput === false
    )
  })

  await withFetch(async () => new Response('busy', { status: 503 }), async () => {
    await assert.rejects(
      fetchProviderStream('https://x.test', {}, 'Test'),
      error => error.retryable === true && /^Test 503: busy/.test(error.message)
    )
  })

  await withFetch(async () => new Response('bad', { status: 400 }), async () => {
    await assert.rejects(
      fetchProviderStream('https://x.test', {}, 'Test'),
      error => error.retryable === false
    )
  })

  const abort = new Error('aborted')
  abort.name = 'AbortError'
  await withFetch(async () => { throw abort }, async () => {
    await assert.rejects(
      fetchProviderStream('https://x.test', {}, 'Test'),
      error => error === abort && error.retryable === undefined
    )
  })
})

test('Ollama meldet abgebrochene Streams als nicht abgeschlossen', async () => {
  const complete = await withFetch(
    async () => lineResponse([
      '{"message":{"content":"Hal"}}',
      '{"message":{"content":"lo"}}',
      '{"done":true,"total_duration":1,"prompt_eval_count":3,"eval_count":2}',
      ''
    ]),
    () => streamOllama('m', [{ role: 'user', content: 'x' }], { tools: [] }, sink)
  )
  assert.equal(complete.completed, true)
  assert.equal(complete.fullContent, 'Hallo')
  assert.equal(complete.tokenUsage.totalTokens, 5)

  const cut = await withFetch(
    async () => lineResponse(['{"message":{"content":"Hal"}}', '']),
    () => streamOllama('m', [{ role: 'user', content: 'x' }], { tools: [] }, sink)
  )
  assert.equal(cut.completed, false)
  assert.equal(cut.fullContent, 'Hal')

  const error = incompleteStreamError('Ollama', cut)
  assert.equal(error.retryable, true)
  assert.equal(error.partialOutput, true)
})

test('Ollama: Verbindungsfehler ist wiederholbar, Modellfehler nicht', async () => {
  await withFetch(async () => { throw new TypeError('fetch failed') }, async () => {
    await assert.rejects(
      streamOllama('m', [], { tools: [] }, sink),
      error => error.retryable === true
    )
  })

  await withFetch(async () => lineResponse(['{"error":"model not found"}', '']), async () => {
    await assert.rejects(
      streamOllama('m', [], { tools: [] }, sink),
      error => error.retryable === false && /model not found/.test(error.message)
    )
  })
})

test('OpenAI-kompatibel: Abbruch mitten im Stream wird mit Teilausgabe markiert', async () => {
  const encoder = new TextEncoder()
  let step = 0
  const body = new ReadableStream({
    pull(controller) {
      if (step++ === 0) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
        ))
      } else {
        controller.error(new TypeError('terminated'))
      }
    }
  })

  await withFetch(async () => new Response(body, { status: 200 }), async () => {
    await assert.rejects(
      streamOpenAICompatible('Z.ai', 'https://x.test', 'key', 'glm', [{ role: 'user', content: 'x' }], { tools: [] }, sink),
      error => error.retryable === true && error.partialOutput === true
    )
  })

  await withFetch(async () => new Response('slow down', { status: 429 }), async () => {
    await assert.rejects(
      streamOpenAICompatible('Z.ai', 'https://x.test', 'key', 'glm', [{ role: 'user', content: 'x' }], { tools: [] }, sink),
      error => error.retryable === true && /^Z\.ai 429/.test(error.message)
    )
  })
})

test('Chat, Agent, Memory und Client nutzen die gemeinsamen Pfade', async () => {
  const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  const [chat, agent, memory, page, panel] = await Promise.all([
    read('server/routes/chat.js'),
    read('server/lib/agentRunner.js'),
    read('server/routes/memory.js'),
    read('client/src/pages/Chat.jsx'),
    read('client/src/components/MemoryPanel.jsx')
  ])

  const directStreamNames =
    /\b(?:streamOllama|streamAnthropic|streamResponses|streamZai|streamKimi|streamLlamaCpp|streamDeepSeekResponses|splitSystemTimeNote)\b/

  assert.doesNotMatch(chat, directStreamNames)
  assert.doesNotMatch(agent, directStreamNames)
  assert.match(chat, /resolveProvider\(activeModel\)/)
  assert.match(chat, /completed === false/)
  assert.doesNotMatch(chat, /__TERMINAL_DONE__/)
  assert.match(chat, /router\.post\('\/:conversationId\(\\\\d\+\)'/)
  assert.doesNotMatch(chat, /router\.(?:get|post)\('\/memory'/)

  assert.match(memory, /completeWithProvider/)
  assert.doesNotMatch(memory, /legacyMarkdown/)
  assert.doesNotMatch(memory, /UPDATE users\s+SET memory/)

  assert.match(page, /json\.think/)
  assert.doesNotMatch(panel, /Legacy-Markdown|\/api\/memory\/save/)
})
