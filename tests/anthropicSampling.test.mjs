import test from 'node:test'
import assert from 'node:assert/strict'

// Der Key ist ein Platzhalter und wird nie an einen echten Server gesendet.
process.env.ANTHROPIC_API_KEY = 'test-key-not-real'

const { streamAnthropic } = await import(
  '../server/providers/anthropic.js'
)

const sink = { write() { return true } }
const MESSAGES = [
  { role: 'system', content: 'Regeln' },
  { role: 'user', content: 'Hallo' }
]

const REJECTION =
  '{"type":"error","error":{"type":"invalid_request_error",' +
  '"message":"`temperature` is deprecated for this model."},' +
  '"request_id":"req_test"}'

function sse(text = 'Hi') {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    },
    { type: 'message_delta', usage: { output_tokens: 2 } },
    { type: 'message_stop' }
  ]

  return new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200 }
  )
}

async function withFetch(handler, run) {
  const calls = []
  const previous = global.fetch
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body))
    return handler(calls.length)
  }
  const originalWarn = console.warn
  console.warn = () => {}

  try {
    return { result: await run(), calls }
  } finally {
    global.fetch = previous
    console.warn = originalWarn
  }
}

test('lehnt das Modell temperature ab, wird einmal ohne wiederholt', async () => {
  const { result, calls } = await withFetch(
    count => count === 1
      ? new Response(REJECTION, { status: 400 })
      : sse('Hallo!'),
    () => streamAnthropic(
      'claude-test-a',
      MESSAGES,
      { tools: [], temperature: 0.7 },
      sink
    )
  )

  assert.equal(calls.length, 2)
  assert.equal(calls[0].temperature, 0.7)
  assert.equal('temperature' in calls[1], false)
  assert.equal(result.completed, true)
  assert.equal(result.fullContent, 'Hallo!')
})

test('das Modell wird gemerkt: spätere Anfragen senden temperature nicht mehr', async () => {
  const { calls } = await withFetch(
    () => sse(),
    () => streamAnthropic(
      'claude-test-a',
      MESSAGES,
      { tools: [], temperature: 0.7 },
      sink
    )
  )

  assert.equal(calls.length, 1)
  assert.equal('temperature' in calls[0], false)
})

test('andere Modelle senden temperature weiterhin', async () => {
  const { calls } = await withFetch(
    () => sse(),
    () => streamAnthropic(
      'claude-test-b',
      MESSAGES,
      { tools: [], temperature: 0.7 },
      sink
    )
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].temperature, 0.7)
})

test('andere 400er werden nicht wiederholt', async () => {
  const { calls } = await withFetch(
    () => new Response(
      '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens too large"}}',
      { status: 400 }
    ),
    async () => {
      await assert.rejects(
        streamAnthropic(
          'claude-test-c',
          MESSAGES,
          { tools: [], temperature: 0.7 },
          sink
        ),
        error =>
          /Anthropic 400/.test(error.message) &&
          error.retryable === false
      )
    }
  )

  assert.equal(calls.length, 1)
})

test('ohne temperature-Einstellung gibt es keinen zweiten Versuch', async () => {
  const { calls } = await withFetch(
    () => new Response(REJECTION, { status: 400 }),
    async () => {
      await assert.rejects(
        streamAnthropic(
          'claude-test-d',
          MESSAGES,
          { tools: [] },
          sink
        ),
        /Anthropic 400/
      )
    }
  )

  assert.equal(calls.length, 1)
  assert.equal('temperature' in calls[0], false)
})

test('mit Thinking wird temperature nie gesendet', async () => {
  const { calls } = await withFetch(
    () => sse(),
    () => streamAnthropic(
      'claude-test-e',
      MESSAGES,
      { tools: [], temperature: 0.7, reasoningEffort: 'high' },
      sink
    )
  )

  assert.equal(calls.length, 1)
  assert.equal('temperature' in calls[0], false)
  assert.equal(calls[0].thinking.type, 'adaptive')
})
