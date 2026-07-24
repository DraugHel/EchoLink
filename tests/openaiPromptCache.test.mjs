import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildPromptCacheKey,
  normalizeResponsesUsage,
  supportsPromptCacheConfig,
  toResponsesInput
} from '../server/providers/openai-responses.js'

test('Responses trennt stabilen System-Prefix von späterem Laufzeitkontext', () => {
  const converted = toResponsesInput([
    {
      role: 'system',
      content: 'Stabile Persona und Regeln'
    },
    {
      role: 'user',
      content: 'Ältere Nachricht'
    },
    {
      role: 'system',
      content: 'Dynamischer Laufzeitkontext'
    },
    {
      role: 'user',
      content: 'Aktuelle Nachricht'
    }
  ])

  assert.equal(
    converted.instructions,
    'Stabile Persona und Regeln'
  )
  assert.deepEqual(
    converted.input.map(item => item.role),
    ['user', 'developer', 'user']
  )
  assert.equal(
    converted.input[1].content[0].text,
    'Dynamischer Laufzeitkontext'
  )
})

test('GPT-5.6 erhält einen stabilen, promptabhängigen Cache-Key', () => {
  const tools = [{
    type: 'function',
    name: 'calendar_list_events',
    parameters: {
      type: 'object',
      properties: {}
    }
  }]
  const first = buildPromptCacheKey(
    'gpt-5.6',
    'Stabile Regeln',
    tools
  )
  const same = buildPromptCacheKey(
    'gpt-5.6',
    'Stabile Regeln',
    tools
  )
  const changed = buildPromptCacheKey(
    'gpt-5.6',
    'Geänderte Regeln',
    tools
  )

  assert.equal(first, same)
  assert.notEqual(first, changed)
  assert.match(
    first,
    /^echolink:gpt-5\.6:[a-f0-9]{24}$/
  )
  assert.equal(
    supportsPromptCacheConfig('gpt-5.6'),
    true
  )
  assert.equal(
    supportsPromptCacheConfig('gpt-5.6-mini'),
    true
  )
  assert.equal(
    supportsPromptCacheConfig('gpt-5.5'),
    false
  )
})

test('Responses-Usage behält Cache-Reads und Cache-Writes', () => {
  assert.deepEqual(
    normalizeResponsesUsage({
      input_tokens: 2400,
      output_tokens: 120,
      total_tokens: 2520,
      input_tokens_details: {
        cached_tokens: 1800,
        cache_write_tokens: 300
      }
    }),
    {
      promptTokens: 2400,
      completionTokens: 120,
      totalTokens: 2520,
      cachedTokens: 1800,
      cacheWriteTokens: 300,
      cacheObserved: true
    }
  )
})

test('Chat und UI verdrahten Cache-Telemetrie', async () => {
  const [
    providerSource,
    chatSource,
    pageSource,
    messageSource,
    statusSource
  ] = await Promise.all([
    readFile(
      new URL(
        '../server/providers/openai-responses.js',
        import.meta.url
      ),
      'utf8'
    ),
    readFile(
      new URL(
        '../server/routes/chat.js',
        import.meta.url
      ),
      'utf8'
    ),
    readFile(
      new URL(
        '../client/src/pages/Chat.jsx',
        import.meta.url
      ),
      'utf8'
    ),
    readFile(
      new URL(
        '../client/src/components/Message.jsx',
        import.meta.url
      ),
      'utf8'
    ),
    readFile(
      new URL(
        '../client/src/components/SystemStatusPanel.jsx',
        import.meta.url
      ),
      'utf8'
    )
  ])

  assert.match(providerSource, /prompt_cache_key/)
  assert.match(providerSource, /prompt_cache_options/)
  assert.match(providerSource, /mode: 'implicit'/)
  assert.match(providerSource, /ttl: '30m'/)

  assert.match(
    chatSource,
    /Trusted runtime context for this request/
  )
  assert.match(chatSource, /mergeTokenUsage/)
  assert.match(chatSource, /cache_write_tokens/)
  assert.match(chatSource, /prompt_cache/)

  assert.match(pageSource, /\/api\/chat\/stats/)
  assert.match(messageSource, /Prompt-Cache:/)
  assert.match(statusSource, /GPT-5\.6 Prompt-Cache/)
})
