import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  streamOpenAICompatible
} from '../server/providers/openai-compatible.js'

function fakeSseFetch(events) {
  const encoder = new TextEncoder()
  return async () => ({
    ok: true,
    body: (async function * stream() {
      for (const event of events) {
        yield encoder.encode(`data: ${event}\n`)
      }
    })()
  })
}

function captureSink() {
  const writes = []
  return {
    writes,
    sink: {
      write(chunk) {
        writes.push(String(chunk))
        return true
      }
    }
  }
}

async function withFakeFetch(fetchImpl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('deferred DeepSeek-style tool round hides normal-content narration', async () => {
  const { writes, sink } = captureSink()

  const result = await withFakeFetch(
    fakeSseFetch([
      JSON.stringify({
        choices: [{ delta: { content: 'I will inspect the library first.' } }]
      }),
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: {
                name: 'audiobookshelf_list_items',
                arguments: '{"libraryId":"lib-1"}'
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      '[DONE]'
    ]),
    () => streamOpenAICompatible(
      'Test',
      'https://example.invalid/chat',
      'test-key',
      'test-model',
      [{ role: 'user', content: 'audit' }],
      { tools: [] },
      sink,
      new AbortController().signal,
      {},
      {
        allowSampling: false,
        deferContentUntilToolOutcome: true
      }
    )
  )

  assert.equal(result.fullContent, 'I will inspect the library first.')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'audiobookshelf_list_items')
  assert.equal(
    writes.some(write => write.includes('"token"')),
    false
  )
})

test('deferred DeepSeek-style final round emits polished content once', async () => {
  const { writes, sink } = captureSink()
  const finalText = '## Ergebnis\n\n- 12 Änderungen angewendet.\n- Keine weiteren Felder geändert.'

  const result = await withFakeFetch(
    fakeSseFetch([
      JSON.stringify({
        choices: [{ delta: { content: '## Ergebnis\n\n' } }]
      }),
      JSON.stringify({
        choices: [{
          delta: { content: '- 12 Änderungen angewendet.\n- Keine weiteren Felder geändert.' },
          finish_reason: 'stop'
        }]
      }),
      '[DONE]'
    ]),
    () => streamOpenAICompatible(
      'Test',
      'https://example.invalid/chat',
      'test-key',
      'test-model',
      [{ role: 'user', content: 'summarize' }],
      { tools: [] },
      sink,
      new AbortController().signal,
      {},
      {
        allowSampling: false,
        deferContentUntilToolOutcome: true
      }
    )
  )

  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.fullContent, finalText)
  const tokenWrites = writes.filter(write => write.includes('"token"'))
  assert.equal(tokenWrites.length, 1)
  assert.match(tokenWrites[0], /## Ergebnis/)
})

test('chat keeps tool-round prose out of persisted final content', () => {
  const chat = fs.readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )
  const provider = fs.readFileSync(
    new URL('../server/providers/openai-compatible.js', import.meta.url),
    'utf8'
  )

  assert.doesNotMatch(
    chat,
    /allContent \+= \(allContent \? '\\\\n\\\\n' : ''\) \+ fullContent/
  )
  assert.match(chat, /if \(fullContent\) allContent = fullContent/)
  assert.match(chat, /DeepSeek presentation policy:/)
  assert.match(provider, /deferContentUntilToolOutcome: true/)
})
