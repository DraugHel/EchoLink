import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createMemoryEvidence,
  parseMemoryEvidence,
  serializeMemoryEvidence
} from '../server/lib/memoryEvidence.js'

test('memory evidence snapshots exactly the selected prompt memories', () => {
  const evidence = createMemoryEvidence([{
    id: 42,
    type: 'profile',
    scope: 'global',
    content: 'Schichtmodell 04–12, 12–20 und 20–04 Uhr.',
    importance: 65,
    confidence: 0.7,
    retrievalMode: 'hybrid',
    retrievalScore: 91.25,
    lexicalScore: 55,
    semanticSimilarity: 0.335628,
    metadata: { secret: 'not exposed' }
  }])

  assert.deepEqual(evidence, [{
    id: 42,
    type: 'profile',
    scope: 'global',
    content: 'Schichtmodell 04–12, 12–20 und 20–04 Uhr.',
    importance: 65,
    confidence: 0.7,
    retrievalMode: 'hybrid',
    retrievalScore: 91.25,
    lexicalScore: 55,
    semanticSimilarity: 0.335628
  }])
})

test('memory evidence roundtrips empty selections and rejects legacy absence', () => {
  assert.deepEqual(
    parseMemoryEvidence(
      serializeMemoryEvidence([])
    ),
    []
  )
  assert.equal(parseMemoryEvidence(''), null)
  assert.equal(parseMemoryEvidence('{broken'), null)
})

test('database migration adds persistent memory evidence to messages', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'echolink-memory-evidence-test-')
  )
  const databasePath = path.join(temporaryRoot, 'echolink.db')
  const script = String.raw`
    const { default: db } = await import('./server/db.js')
    const columns = db.prepare('PRAGMA table_info(messages)').all()
    if (!columns.some(column => column.name === 'memory_evidence')) {
      throw new Error('memory_evidence column missing')
    }
    db.close()
  `

  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          ECHOLINK_DB_PATH: databasePath
        },
        encoding: 'utf8'
      }
    )

    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}`
    )
  } finally {
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true
    })
  }
})

test('chat, history API and UI carry memory evidence without a model call', () => {
  const chat = fs.readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )
  const conversations = fs.readFileSync(
    new URL('../server/routes/conversations.js', import.meta.url),
    'utf8'
  )
  const page = fs.readFileSync(
    new URL('../client/src/pages/Chat.jsx', import.meta.url),
    'utf8'
  )
  const message = fs.readFileSync(
    new URL('../client/src/components/Message.jsx', import.meta.url),
    'utf8'
  )

  assert.match(chat, /createMemoryEvidence\(\s*selectedMemoryItems/)
  assert.match(chat, /memory_evidence/)
  assert.match(chat, /chatStream\.write\(`data:.*memoryEvidence/s)
  assert.match(conversations, /parseMemoryEvidence/)
  assert.match(page, /memoryEvidence=\{m\.memoryEvidence\}/)
  assert.match(message, /Memory anzeigen/)
  assert.match(message, /Keine strukturierte Memory geladen/)
  assert.match(message, /Keine strukturierte Memory geladen/)
})
