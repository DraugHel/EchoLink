import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  isRecallOnlyRequest,
  recallRuntimeInstruction
} from '../server/lib/memoryRecallPolicy.js'

test('plain conversation recall is tool-free', () => {
  assert.equal(
    isRecallOnlyRequest(
      'Was hatten wir damals als Ursache für den knappen Plattenplatz identifiziert?'
    ),
    true
  )
  assert.equal(
    isRecallOnlyRequest('Erinnerst du dich, welches Modell wir gewählt haben?'),
    true
  )
  assert.equal(
    isRecallOnlyRequest('Weißt du noch, was wir vereinbart hatten?'),
    true
  )
  assert.equal(
    isRecallOnlyRequest('weißt du mein schichtmodell noch?'),
    true
  )
})

test('explicit investigation remains fully tool-capable', () => {
  assert.equal(
    isRecallOnlyRequest(
      'Was hatten wir damals identifiziert? Prüf bitte den aktuellen Serverstatus.'
    ),
    false
  )
  assert.equal(
    isRecallOnlyRequest(
      'Erinnerst du dich an den Fehler? Suche jetzt in den Logs danach.'
    ),
    false
  )
})

test('ordinary agent work is not classified as recall', () => {
  assert.equal(
    isRecallOnlyRequest('Analysiere den Speicher und behebe die Ursache.'),
    false
  )
  assert.equal(
    isRecallOnlyRequest('Deploye EchoLink und prüfe danach PM2.'),
    false
  )
})

test('recall instruction distinguishes a hit from a miss', () => {
  assert.match(
    recallRuntimeInstruction({ hasRecallMatch: true }),
    /Answer directly/
  )
  assert.match(
    recallRuntimeInstruction({ hasRecallMatch: false }),
    /No matching structured memory/
  )
  assert.match(
    recallRuntimeInstruction({ hasRecallMatch: false }),
    /Tools are intentionally unavailable/
  )
})

test('chat runtime disables tools only for recall-only requests', () => {
  const source = fs.readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )

  assert.match(source, /isRecallOnlyRequest\(/)
  assert.match(source, /tools:\s*recallOnlyRequest\s*\?\s*\[\]/)
  assert.match(source, /recallRuntimeInstruction\(/)
})
