import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  deepSeekReasoningEffort,
  normalizeDeepSeekResponsesModel,
  streamDeepSeekResponsesCore,
  toDeepSeekResponsesInput,
  toDeepSeekResponsesTools
} from '../server/providers/deepseek-responses.js'

function fakeResponse(events, status = 200) {
  const encoder = new TextEncoder()
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return status >= 200 && status < 300
        ? ''
        : 'upstream failed'
    },
    body: (async function * stream() {
      for (const event of events) {
        yield encoder.encode(
          `data: ${JSON.stringify(event)}\n\n`
        )
      }
    })()
  }
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

test('DeepSeek Responses maps legacy flash model and reasoning effort', () => {
  assert.equal(
    normalizeDeepSeekResponsesModel(
      'deepseek-v4-flash'
    ),
    'deepseek-flash'
  )
  assert.equal(
    normalizeDeepSeekResponsesModel(
      'deepseek-v4-pro'
    ),
    'deepseek-v4-pro'
  )
  assert.equal(deepSeekReasoningEffort('off'), 'none')
  assert.equal(deepSeekReasoningEffort('medium'), 'high')
  assert.equal(deepSeekReasoningEffort('max'), 'max')
})

test('DeepSeek Responses converts tools to flat Responses shape', () => {
  const tools = toDeepSeekResponsesTools([{
    type: 'function',
    function: {
      name: 'demo_tool',
      description: 'demo',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  }])

  assert.deepEqual(tools, [{
    type: 'function',
    name: 'demo_tool',
    description: 'demo',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }])
})

test('DeepSeek Responses keeps reasoning/function calls and pairs tool output', () => {
  const raw = [
    {
      type: 'reasoning',
      id: 'rs_1',
      content: [{
        type: 'reasoning_text',
        text: 'Need current data.'
      }]
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'demo_tool',
      arguments: '{"value":1}'
    }
  ]

  const converted = toDeepSeekResponsesInput([
    {
      role: 'system',
      content: 'Primary system'
    },
    {
      role: 'user',
      content: 'Check it'
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        function: {
          name: 'demo_tool',
          arguments: { value: 1 }
        }
      }],
      _raw: raw
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"ok":true}'
    }
  ])

  assert.equal(
    converted.instructions,
    'Primary system'
  )
  assert.deepEqual(
    converted.input.slice(1, 3),
    raw
  )
  assert.deepEqual(
    converted.input[3],
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"ok":true}'
    }
  )
})

test('DeepSeek Responses streams reasoning separately and returns function call', async () => {
  const { writes, sink } = captureSink()
  let requestBody

  const result = await streamDeepSeekResponsesCore(
    'deepseek-v4-flash',
    [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Use a tool' }
    ],
    {
      reasoningEffort: 'high',
      tools: [{
        type: 'function',
        function: {
          name: 'demo_tool',
          description: 'demo',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        }
      }]
    },
    sink,
    new AbortController().signal,
    {
      key: 'test-key',
      fetchImpl: async (url, options) => {
        requestBody = JSON.parse(options.body)
        return fakeResponse([
          {
            type: 'response.reasoning_text.delta',
            delta: 'Need the tool.'
          },
          {
            type: 'response.completed',
            response: {
              output: [
                {
                  type: 'reasoning',
                  id: 'rs_1',
                  content: [{
                    type: 'reasoning_text',
                    text: 'Need the tool.'
                  }]
                },
                {
                  type: 'function_call',
                  id: 'fc_1',
                  call_id: 'call_1',
                  name: 'demo_tool',
                  arguments: '{}'
                }
              ],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                input_tokens_details: {
                  cached_tokens: 4
                }
              }
            }
          }
        ])
      }
    }
  )

  assert.equal(
    requestBody.model,
    'deepseek-flash'
  )
  assert.equal(
    requestBody.reasoning.effort,
    'high'
  )
  assert.equal(result.toolCalls.length, 1)
  assert.equal(
    result.toolCalls[0].function.name,
    'demo_tool'
  )
  assert.equal(result.fullContent, '')
  assert.equal(result.fullThinking, 'Need the tool.')
  assert.equal(result.tokenUsage.cachedTokens, 4)
  assert.equal(
    writes.some(write => write.includes('"think"')),
    true
  )
  assert.equal(
    writes.some(write => write.includes('"token"')),
    false
  )
})

test('DeepSeek Responses streams final message as normal user-facing output', async () => {
  const { writes, sink } = captureSink()

  const result = await streamDeepSeekResponsesCore(
    'deepseek-flash',
    [{ role: 'user', content: 'Finish' }],
    { tools: [] },
    sink,
    new AbortController().signal,
    {
      key: 'test-key',
      fetchImpl: async () => fakeResponse([
        {
          type: 'response.output_text.delta',
          delta: '## Ergebnis\n\n'
        },
        {
          type: 'response.output_text.delta',
          delta: '- Fertig.'
        },
        {
          type: 'response.completed',
          response: {
            output: [{
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              content: [{
                type: 'output_text',
                text: '## Ergebnis\n\n- Fertig.'
              }]
            }],
            usage: {
              input_tokens: 5,
              output_tokens: 3,
              total_tokens: 8
            }
          }
        }
      ])
    }
  )

  assert.equal(
    result.fullContent,
    '## Ergebnis\n\n- Fertig.'
  )
  assert.equal(result.toolCalls.length, 0)
  assert.equal(
    writes.filter(write =>
      write.includes('"token"')
    ).length,
    2
  )
})

test('DeepSeek Responses fails explicitly on incomplete content filter', async () => {
  const { sink } = captureSink()

  await assert.rejects(
    streamDeepSeekResponsesCore(
      'deepseek-flash',
      [{ role: 'user', content: 'Finish' }],
      { tools: [] },
      sink,
      new AbortController().signal,
      {
        key: 'test-key',
        fetchImpl: async () => fakeResponse([
          {
            type: 'response.incomplete',
            response: {
              output: [],
              incomplete_details: {
                reason: 'content_filter'
              },
              usage: {
                input_tokens: 1,
                output_tokens: 0,
                total_tokens: 1
              }
            }
          }
        ])
      }
    ),
    /DeepSeek Responses incomplete: content_filter/
  )
})

test('EchoLink routes DeepSeek chat, scheduled agents and summaries through Responses', () => {
  const chat = fs.readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )
  const agent = fs.readFileSync(
    new URL('../server/lib/agentRunner.js', import.meta.url),
    'utf8'
  )
  const summary = fs.readFileSync(
    new URL(
      '../server/lib/conversationSummaryProvider.js',
      import.meta.url
    ),
    'utf8'
  )
  const compatible = fs.readFileSync(
    new URL(
      '../server/providers/openai-compatible.js',
      import.meta.url
    ),
    'utf8'
  )

  for (const source of [chat, agent, summary]) {
    assert.match(
      source,
      /streamDeepSeekResponses/
    )
  }

  assert.doesNotMatch(
    chat,
    /DeepSeek presentation policy:/
  )
  assert.doesNotMatch(
    compatible,
    /deferContentUntilToolOutcome/
  )
})
