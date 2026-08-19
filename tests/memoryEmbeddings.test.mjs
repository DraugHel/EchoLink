import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  hybridMemoryScore,
  memoryEmbeddingQuery,
  memoryEmbeddingSource,
  memorySemanticThreshold,
  normalizeEmbedding,
  sha256Text,
  shouldUseRecentMemoryContext
} from '../server/lib/memoryEmbeddingCore.js'
import {
  createOllamaEmbeddingClient
} from '../server/lib/memoryEmbeddingClient.js'

test('short memory queries include recent conversational context', () => {
  const query = memoryEmbeddingQuery(
    'okay go',
    'We discussed semantic memory retrieval for EchoLink.'
  )

  assert.match(query, /^task: search result \| query: okay go/)
  assert.match(query, /Recent conversation context:/)
  assert.match(query, /semantic memory retrieval/)
})

test('explicit recall queries do not inherit unrelated recent context', () => {
  const query = memoryEmbeddingQuery(
    'Weißt du mein Schichtmodell noch?',
    'The previous message only discussed the Termius package name.'
  )

  assert.equal(
    shouldUseRecentMemoryContext('Weißt du mein Schichtmodell noch?'),
    false
  )
  assert.doesNotMatch(query, /Termius package/)
  assert.match(query, /Schichtmodell/)
})

test('recall uses the measured semantic boundary without weakening normal turns', () => {
  assert.equal(
    memorySemanticThreshold('0.45'),
    0.45
  )
  assert.equal(
    memorySemanticThreshold('0.45', { recallOnly: true }),
    0.28
  )
  assert.ok(hybridMemoryScore({
    lexicalScore: -1000,
    semanticSimilarity: 0.335,
    semanticThreshold: memorySemanticThreshold(
      '0.45',
      { recallOnly: true }
    )
  }) > 0)
})

test('standalone memory queries do not inherit stale context', () => {
  const query = memoryEmbeddingQuery(
    'Explain in detail why the Docker container storage is using so much disk space on the production server and list the relevant directories.',
    'Unrelated earlier conversation'
  )

  assert.doesNotMatch(query, /Unrelated earlier conversation/)
})

test('memory embedding source binds type, scope and content', () => {
  const first = memoryEmbeddingSource({
    type: 'project',
    scope: 'project:echolink',
    content: 'Validator images consume disk space.'
  })
  const second = memoryEmbeddingSource({
    type: 'fact',
    scope: 'global',
    content: 'Validator images consume disk space.'
  })

  assert.match(first, /^title: none \| text:/)
  assert.notEqual(sha256Text(first), sha256Text(second))
  assert.match(sha256Text(first), /^[0-9a-f]{64}$/)
})

test('embedding codec normalizes and roundtrips Float32 data', () => {
  const normalized = normalizeEmbedding([3, 4], 2)
  const decoded = decodeEmbedding(
    encodeEmbedding(normalized),
    2
  )

  assert.ok(Math.abs(decoded[0] - 0.6) < 1e-6)
  assert.ok(Math.abs(decoded[1] - 0.8) < 1e-6)
  assert.ok(Math.abs(cosineSimilarity(normalized, decoded) - 1) < 1e-6)
})

test('embedding codec rejects malformed vectors and blobs', () => {
  assert.throws(
    () => normalizeEmbedding([1, Number.NaN], 2),
    /non-finite/
  )
  assert.throws(
    () => decodeEmbedding(Buffer.alloc(3), 2),
    /byte length/
  )
})

test('hybrid ranking admits semantic matches without lexical overlap', () => {
  const semanticOnly = hybridMemoryScore({
    lexicalScore: -1000,
    semanticSimilarity: 0.72,
    semanticThreshold: 0.45
  })
  const irrelevant = hybridMemoryScore({
    lexicalScore: -1000,
    semanticSimilarity: 0.2,
    semanticThreshold: 0.45
  })
  const hybrid = hybridMemoryScore({
    lexicalScore: 55,
    semanticSimilarity: 0.72,
    semanticThreshold: 0.45
  })

  assert.ok(semanticOnly > 0)
  assert.equal(irrelevant, null)
  assert.ok(hybrid > semanticOnly)
})

test('conversation and standing memories remain pinned', () => {
  assert.ok(hybridMemoryScore({
    lexicalScore: -1000,
    semanticSimilarity: null,
    exactConversation: true
  }) > 0)

  assert.ok(hybridMemoryScore({
    lexicalScore: -1000,
    semanticSimilarity: null,
    globalStanding: true
  }) > 0)
})

test('Ollama embedding client sends bounded multilingual retrieval request', async () => {
  let request = null
  const client = createOllamaEmbeddingClient({
    baseUrl: 'http://127.0.0.1:11434/',
    model: 'embeddinggemma',
    dimensions: 2,
    keepAlive: '0s',
    fetchImpl: async (url, options) => {
      request = {
        url,
        options,
        body: JSON.parse(options.body)
      }

      return new Response(JSON.stringify({
        model: 'embeddinggemma',
        embeddings: [[3, 4]]
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      })
    }
  })

  const [vector] = await client.embed(['Speicherproblem'])

  assert.equal(request.url, 'http://127.0.0.1:11434/api/embed')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(request.body, {
    model: 'embeddinggemma',
    input: ['Speicherproblem'],
    truncate: true,
    dimensions: 2,
    keep_alive: '0s'
  })
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-6)
})

test('Ollama embedding failures are explicit for the fallback layer', async () => {
  const client = createOllamaEmbeddingClient({
    dimensions: 2,
    fetchImpl: async () => new Response('model missing', {
      status: 404
    })
  })

  await assert.rejects(
    () => client.embed(['query']),
    /Ollama embedding 404: model missing/
  )
})

test('database and chat wire semantic retrieval without changing prompt caps', () => {
  const database = fs.readFileSync(
    new URL('../server/db.js', import.meta.url),
    'utf8'
  )
  const chat = fs.readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )
  const memoryItems = fs.readFileSync(
    new URL('../server/lib/memoryItems.js', import.meta.url),
    'utf8'
  )

  assert.match(database, /CREATE TABLE IF NOT EXISTS memory_embeddings/)
  assert.match(database, /ON DELETE CASCADE/)
  assert.match(chat, /await selectMemoryItemsForContext\(/)
  assert.match(chat, /limit: 10/)
  assert.match(chat, /maxChars: 6000/)
  assert.match(memoryItems, /semanticScoresForMemoryItems/)
  assert.match(memoryItems, /hybridMemoryScore/)
  assert.match(memoryItems, /recallOnly:\s*options\.recallOnly === true/)
  assert.match(chat, /recallOnly:\s*recallOnlyRequest/)
})

test('SQLite integration stores, retrieves, invalidates and cascades embeddings', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'echolink-memory-embedding-test-')
  )
  const databasePath = path.join(temporaryRoot, 'echolink.db')
  const script = String.raw`
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body)
      const embeddings = body.input.map(input => {
        if (input.includes('query: Warum ist die Platte voll?')) {
          return [1, ...Array(127).fill(0)]
        }
        if (input.includes('Containerd validator layers')) {
          return [1, ...Array(127).fill(0)]
        }
        if (input.includes('query: Wo liegt die Sicherung?')) {
          return [0, 0, 1, ...Array(125).fill(0)]
        }
        if (input.includes('Offsite snapshots')) {
          return [0, 0, 1, ...Array(125).fill(0)]
        }
        return [0, 1, ...Array(126).fill(0)]
      })

      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const { default: db } = await import('./server/db.js')
    const {
      createMemoryItem,
      deleteMemoryItem,
      selectMemoryItemsForContext,
      updateMemoryItem
    } = await import('./server/lib/memoryItems.js')
    const {
      refreshMemoryEmbeddingsByIds
    } = await import('./server/lib/memoryEmbeddings.js')

    const user = db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run('embedding-test', 'unused')
    const userId = Number(user.lastInsertRowid)

    const storage = createMemoryItem(userId, {
      type: 'project',
      scope: 'project:echolink',
      content: 'Containerd validator layers consume storage.',
      importance: 80,
      confidence: 1
    })
    const music = createMemoryItem(userId, {
      type: 'preference',
      scope: 'global',
      content: 'The user likes tenor saxophone music.',
      importance: 70,
      confidence: 1
    })
    const shiftModel = createMemoryItem(userId, {
      type: 'profile',
      scope: 'global',
      content: 'Arbeitet bei Novartis im Schichtmodell 04–12, 12–20 und 20–04 Uhr.',
      importance: 65,
      confidence: 0.7
    })

    const indexed = await refreshMemoryEmbeddingsByIds(
      userId,
      [storage.id, music.id, shiftModel.id]
    )
    if (indexed.indexed !== 3) throw new Error('index count mismatch')

    const recalledShift = await selectMemoryItemsForContext(
      userId,
      'weißt du mein schichtmodell noch?',
      {
        conversationId: 0,
        limit: 10,
        maxChars: 6000,
        recentContext: 'The previous turn only discussed com.termmius.Termius.',
        recallOnly: true
      }
    )
    if (recalledShift[0]?.id !== shiftModel.id) {
      throw new Error('literal recall missed the stored shift model')
    }
    if (recalledShift[0]?.lexicalScore === null) {
      throw new Error('literal recall did not retain its lexical match')
    }

    const selected = await selectMemoryItemsForContext(
      userId,
      'Warum ist die Platte voll?',
      { conversationId: 0, limit: 10, maxChars: 6000 }
    )
    if (selected[0]?.id !== storage.id) {
      throw new Error('semantic retrieval missed storage memory')
    }
    if (selected[0]?.retrievalMode !== 'semantic') {
      throw new Error('expected semantic-only retrieval')
    }

    const backup = createMemoryItem(userId, {
      type: 'project',
      scope: 'project:echolink',
      content: 'Offsite snapshots are retained in the recovery vault.',
      importance: 75,
      confidence: 1
    })
    const selfHealed = await selectMemoryItemsForContext(
      userId,
      'Wo liegt die Sicherung?',
      { conversationId: 0, limit: 10, maxChars: 6000 }
    )
    if (selfHealed[0]?.id !== backup.id) {
      throw new Error('on-demand embedding repair failed')
    }
    const repaired = db.prepare(
      'SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?'
    ).get(backup.id)
    if (repaired.count !== 1) {
      throw new Error('on-demand embedding was not persisted')
    }

    globalThis.fetch = async () => new Response(
      'temporary Ollama failure',
      { status: 503 }
    )
    const lexicalFallback = await selectMemoryItemsForContext(
      userId,
      'Containerd',
      { conversationId: 0, limit: 10, maxChars: 6000 }
    )
    if (lexicalFallback[0]?.id !== storage.id) {
      throw new Error('lexical fallback failed after embedding outage')
    }
    if (lexicalFallback[0]?.retrievalMode !== 'lexical') {
      throw new Error('embedding outage did not use lexical mode')
    }

    updateMemoryItem(userId, storage.id, {
      content: 'A completely changed memory about gardening.'
    })
    const stale = await selectMemoryItemsForContext(
      userId,
      'Warum ist die Platte voll?',
      { conversationId: 0, limit: 10, maxChars: 6000 }
    )
    if (stale.some(item => item.id === storage.id)) {
      throw new Error('stale embedding remained eligible')
    }

    deleteMemoryItem(userId, storage.id)
    const remaining = db.prepare(
      'SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?'
    ).get(storage.id)
    if (remaining.count !== 0) {
      throw new Error('embedding did not cascade on delete')
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
          ECHOLINK_DB_PATH: databasePath,
          MEMORY_EMBEDDINGS_ENABLED: 'true',
          MEMORY_EMBEDDING_DIMENSIONS: '128',
          MEMORY_EMBEDDING_FALLBACK_COOLDOWN_MS: '5000'
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
