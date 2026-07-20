import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  cancelChatRun,
  createChatRun,
  finishChatRun,
  markChatRunTool,
  markChatRunWriting,
  shouldShowChatRun
} from '../client/src/lib/chatRunState.js'

test('Chat-Cockpit bleibt bei Smalltalk verborgen und startet bei Aufträgen', () => {
  assert.equal(
    shouldShowChatRun({ content: 'Hallo!' }),
    false
  )

  assert.equal(
    shouldShowChatRun({
      content: 'Prüfe bitte die letzten Logs und fasse die Fehler zusammen.'
    }),
    true
  )

  assert.equal(
    shouldShowChatRun({
      content: 'Was ist darauf zu sehen?',
      attachments: [{ kind: 'image' }]
    }),
    true
  )
})

test('Chat-Run bildet Plan, Toolschritt, Antwort und Abschluss ab', () => {
  let run = createChatRun({
    id: 'a_test',
    content: 'Recherchiere drei Quellen und fasse sie zusammen.',
    startedAt: 100
  })

  assert.equal(run.status, 'running')
  assert.equal(run.phase, 'planning')
  assert.equal(run.plan.length, 5)
  assert.equal(run.events.length, 3)

  run = markChatRunTool(run, {
    tool: 'web_search',
    status: 'running',
    query: 'EchoLink Agenten'
  })

  assert.equal(run.currentStep, 1)
  assert.equal(run.events.at(-1).type, 'tool_started')

  run = markChatRunTool(run, {
    tool: 'web_search',
    status: 'done',
    resultCount: 3
  })

  assert.equal(run.currentStep, 2)
  assert.equal(run.events.at(-1).type, 'tool_finished')

  run = markChatRunWriting(run)
  assert.equal(run.currentStep, 3)

  run = finishChatRun(run, 120)
  assert.equal(run.status, 'success')
  assert.equal(run.phase, 'success')
  assert.equal(run.finishedAt, 120)
  assert.equal(run.events.at(-1).type, 'completed')
})

test('Abgebrochener Chat-Run ist cancelled und nicht failed', () => {
  const run = cancelChatRun(
    createChatRun({
      id: 'a_cancel',
      content: 'Prüfe den Systemstatus.',
      startedAt: 200
    }),
    210
  )

  assert.equal(run.status, 'cancelled')
  assert.equal(run.phase, 'cancelled')
  assert.equal(run.controlState, 'cancelled')
  assert.equal(run.error, null)
})

test('Worker speichert geplante Abbrüche als cancelled und loggt sie normal', () => {
  const worker = fs.readFileSync(
    new URL('../server/worker.js', import.meta.url),
    'utf8'
  )

  assert.match(
    worker,
    /status:\s*cancelled\s*\?\s*'cancelled'\s*:\s*'failed'/
  )
  assert.match(
    worker,
    /if \(cancelled\) \{\s*console\.log\(logPayload\)/
  )
})
