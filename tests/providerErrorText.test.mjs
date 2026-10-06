import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  fetchProviderStream,
  providerErrorText
} from '../server/providers/streamErrors.js'

test('JSON-Fehler der Anbieter werden auf die eigentliche Meldung gekürzt', () => {
  // Anthropic
  assert.equal(
    providerErrorText(
      '{"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"`temperature` is deprecated for this model."},' +
      '"request_id":"req_x"}'
    ),
    '`temperature` is deprecated for this model.'
  )

  // OpenAI-kompatibel (OpenAI, Z.ai, Kimi)
  assert.equal(
    providerErrorText(
      '{"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","code":"invalid_api_key"}}'
    ),
    'Incorrect API key provided.'
  )

  // Ollama
  assert.equal(
    providerErrorText('{"error":"model \'x\' not found"}'),
    "model 'x' not found"
  )

  // Meldung auf oberster Ebene
  assert.equal(
    providerErrorText('{"message":"Rate limit reached"}'),
    'Rate limit reached'
  )
})

test('Zeilenumbrüche werden geglättet und lange Meldungen gekürzt', () => {
  assert.equal(
    providerErrorText('{"error":{"message":"zeile eins\\n\\n   zeile zwei"}}'),
    'zeile eins zeile zwei'
  )

  const long = providerErrorText(
    JSON.stringify({ error: { message: 'x'.repeat(900) } })
  )
  assert.equal(long.length, 300)
})

test('Kein JSON oder keine Meldung: Rohtext gekürzt, leer bleibt leer', () => {
  assert.equal(providerErrorText('busy'), 'busy')
  assert.equal(providerErrorText('y'.repeat(500)).length, 200)
  assert.equal(providerErrorText(''), '')
  assert.equal(providerErrorText(null), '')
  assert.equal(providerErrorText('{"foo":"bar"}'), '{"foo":"bar"}')
  assert.equal(providerErrorText('{"error":{"code":1}}'), '{"error":{"code":1}}')
})

test('fetchProviderStream meldet Status und lesbare Meldung', async () => {
  const previous = global.fetch

  try {
    global.fetch = async () =>
      new Response(
        '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
        { status: 400 }
      )

    await assert.rejects(
      fetchProviderStream('https://x.test', {}, 'Anthropic'),
      error =>
        error.message ===
          'Anthropic 400: `temperature` is deprecated for this model.' &&
        error.retryable === false
    )

    global.fetch = async () =>
      new Response('upstream busy', { status: 503 })

    await assert.rejects(
      fetchProviderStream('https://x.test', {}, 'Z.ai'),
      error =>
        error.message === 'Z.ai 503: upstream busy' &&
        error.retryable === true
    )
  } finally {
    global.fetch = previous
  }
})

test('Neuer Chat wartet nicht auf die Memory-Aktualisierung des alten', () => {
  const chat = readFileSync(
    new URL('../client/src/pages/Chat.jsx', import.meta.url),
    'utf8'
  )

  assert.doesNotMatch(
    chat,
    /await api\.post\(`\/api\/memory\/update\//
  )
  assert.match(
    chat,
    /api\.post\(`\/api\/memory\/update\/\$\{activeConvo\.id\}`, \{\}\)\.catch\(\(\) => \{\}\)/
  )
})
