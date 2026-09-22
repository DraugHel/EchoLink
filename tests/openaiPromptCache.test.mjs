import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildPromptCacheKey,
  normalizeResponsesUsage,
  isRetryableResponsesStatus,
  normalizeResponsesToolArguments,
  supportsPromptCacheConfig,
  toResponsesInput,
  toResponsesTools
} from '../server/providers/openai-responses.js'

test('Responses retries only transient HTTP statuses', () => {
  assert.equal(isRetryableResponsesStatus(408), true)
  assert.equal(isRetryableResponsesStatus(429), true)
  assert.equal(isRetryableResponsesStatus(500), true)
  assert.equal(isRetryableResponsesStatus(503), true)
  assert.equal(isRetryableResponsesStatus(400), false)
  assert.equal(isRetryableResponsesStatus(401), false)
})

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

test('Responses setzt explizite Breakpoints vor variablem Laufzeitkontext', () => {
  const converted = toResponsesInput(
    [
      {
        role: 'system',
        content: 'Stabile Regeln'
      },
      {
        role: 'user',
        content: 'Erste Frage'
      },
      {
        role: 'assistant',
        content: 'Erste Antwort'
      },
      {
        role: 'user',
        content:
          'Aktuelle Frage\n\n[Dynamische Uhrzeit]',
        _promptCacheStableContent:
          'Aktuelle Frage'
      }
    ],
    {
      explicitPromptCache: true
    }
  )

  assert.deepEqual(
    converted.input[0].content[0]
      .prompt_cache_breakpoint,
    {
      mode: 'explicit'
    }
  )
  assert.deepEqual(
    converted.input[2].content,
    [
      {
        type: 'input_text',
        text: 'Aktuelle Frage',
        prompt_cache_breakpoint: {
          mode: 'explicit'
        }
      },
      {
        type: 'input_text',
        text: '\n\n[Dynamische Uhrzeit]'
      }
    ]
  )
})

test('Andere Modelle erhalten keine GPT-5.6-Breakpoints', () => {
  const converted = toResponsesInput([
    {
      role: 'user',
      content: 'Hallo'
    }
  ])

  assert.equal(
    Object.prototype.hasOwnProperty.call(
      converted.input[0].content[0],
      'prompt_cache_breakpoint'
    ),
    false
  )
})

test('GPT-5.6 und GPT-6 unterstützen EchoLinks expliziten Prompt-Cache', () => {
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
    supportsPromptCacheConfig('gpt-6-astra'),
    true
  )
  assert.equal(
    supportsPromptCacheConfig('gpt-6-sol'),
    true
  )
  assert.equal(
    supportsPromptCacheConfig('gpt-6-luna'),
    true
  )
  assert.equal(
    supportsPromptCacheConfig('gpt-5.5'),
    false
  )
})


test('Responses macht nur History-Tools strict und nutzt nullable Unix-Zeitfilter', () => {
  const sourceTools = [
    {
      type: 'function',
      function: {
        name: 'search_chat_history',
        description: 'history search',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            date_from: { type: 'string' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'terminal',
        description: 'terminal',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' }
          },
          required: ['command']
        }
      }
    }
  ]

  const [history, terminal] = toResponsesTools(sourceTools)

  assert.equal(history.strict, true)
  assert.equal(history.parameters.additionalProperties, false)
  assert.deepEqual(
    history.parameters.required,
    [
      'query',
      'date_from_unix',
      'date_to_unix',
      'include_archived',
      'limit'
    ]
  )
  assert.deepEqual(
    history.parameters.properties.date_from_unix.type,
    ['integer', 'null']
  )
  assert.match(
    history.parameters.properties.date_from_unix.description,
    /MUST be null unless the user explicitly requested a time window/
  )
  assert.equal(
    Object.hasOwn(history.parameters.properties, 'date_from'),
    false
  )

  assert.equal(
    Object.hasOwn(terminal, 'strict'),
    false
  )
  assert.deepEqual(
    terminal.parameters,
    sourceTools[1].function.parameters
  )
})

test('Responses kanonisiert History-Zeitfilter ohne fragile ISO-Modellstrings', () => {
  assert.deepEqual(
    normalizeResponsesToolArguments(
      'search_chat_history',
      {
        query: '134 liter',
        date_from_unix: null,
        date_to_unix: null,
        include_archived: null,
        limit: null
      }
    ),
    {
      query: '134 liter'
    }
  )

  assert.deepEqual(
    normalizeResponsesToolArguments(
      'search_chat_history',
      {
        query: '134 liter',
        date_from_unix: 1787788800,
        date_to_unix: 1787875200,
        include_archived: true,
        limit: 5
      }
    ),
    {
      query: '134 liter',
      date_from: '2026-08-27T00:00:00.000Z',
      date_to: '2026-08-28T00:00:00.000Z',
      include_archived: true,
      limit: 5
    }
  )

  assert.deepEqual(
    normalizeResponsesToolArguments(
      'read_chat_excerpt',
      {
        conversation_id: 10,
        message_id: 105,
        before: null,
        after: 2
      }
    ),
    {
      conversation_id: 10,
      message_id: 105,
      after: 2
    }
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
  assert.match(providerSource, /mode: 'explicit'/)
  assert.match(
    providerSource,
    /prompt_cache_breakpoint/
  )
  assert.match(providerSource, /ttl: '30m'/)

  assert.match(
    chatSource,
    /Trusted runtime context for this request/
  )
  assert.match(
    chatSource,
    /_promptCacheStableContent/
  )
  assert.match(chatSource, /mergeTokenUsage/)
  assert.match(chatSource, /cache_write_tokens/)
  assert.match(chatSource, /prompt_cache/)
  assert.match(chatSource, /gpt-\[4-9\]/)

  assert.match(pageSource, /\/api\/chat\/stats/)
  assert.match(messageSource, /Prompt-Cache:/)
  assert.match(statusSource, /OpenAI Prompt-Cache/)
})

test('Responses behandelt incomplete und fehlende Terminalevents explizit', async () => {
  const source = await readFile(
    new URL(
      '../server/providers/openai-responses.js',
      import.meta.url
    ),
    'utf8'
  )
  assert.match(source, /response\.incomplete/)
  assert.match(source, /OpenAI Responses incomplete:/)
  assert.match(source, /stream ended without a terminal event/)
})
