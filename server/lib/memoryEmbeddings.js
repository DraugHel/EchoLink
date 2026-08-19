import db from '../db.js'
import {
  createOllamaEmbeddingClient
} from './memoryEmbeddingClient.js'
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  memoryEmbeddingQuery,
  memoryEmbeddingSource,
  sha256Text
} from './memoryEmbeddingCore.js'

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isInteger(parsed)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, parsed))
}

export function memoryEmbeddingConfig() {
  return {
    enabled:
      process.env.MEMORY_EMBEDDINGS_ENABLED !== 'false',
    baseUrl:
      process.env.MEMORY_EMBEDDING_URL ||
      process.env.OLLAMA_URL ||
      'http://127.0.0.1:11434',
    model:
      process.env.MEMORY_EMBEDDING_MODEL ||
      'embeddinggemma',
    dimensions: boundedInteger(
      process.env.MEMORY_EMBEDDING_DIMENSIONS,
      256,
      128,
      1024
    ),
    timeoutMs: boundedInteger(
      process.env.MEMORY_EMBEDDING_TIMEOUT_MS,
      8000,
      1000,
      30000
    ),
    cooldownMs: boundedInteger(
      process.env.MEMORY_EMBEDDING_FALLBACK_COOLDOWN_MS,
      60000,
      5000,
      600000
    ),
    keepAlive:
      process.env.MEMORY_EMBEDDING_KEEP_ALIVE ||
      '0s'
  }
}

let circuitOpenUntil = 0
let lastLoggedFailure = ''

function clientFor(config, fetchImpl) {
  return createOllamaEmbeddingClient({
    baseUrl: config.baseUrl,
    model: config.model,
    dimensions: config.dimensions,
    timeoutMs: config.timeoutMs,
    keepAlive: config.keepAlive,
    fetchImpl
  })
}

function openCircuit(config, error) {
  circuitOpenUntil = Date.now() + config.cooldownMs
  const message = error?.message || String(error)

  if (message !== lastLoggedFailure) {
    lastLoggedFailure = message
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'memory_embeddings_fallback',
      model: config.model,
      reason: message.slice(0, 300),
      retryAfter: new Date(circuitOpenUntil).toISOString()
    }))
  }
}

function closeCircuit() {
  circuitOpenUntil = 0
  lastLoggedFailure = ''
}

function activeEmbeddingRows(items, config) {
  if (!items.length) {
    return []
  }

  const placeholders = items.map(() => '?').join(', ')

  return db.prepare(`
    SELECT
      memory_id,
      source_sha256,
      vector
    FROM memory_embeddings
    WHERE model = ?
      AND dimensions = ?
      AND memory_id IN (${placeholders})
  `).all(
    config.model,
    config.dimensions,
    ...items.map(item => item.id)
  )
}

function currentRowsByMemoryId(items, config) {
  const itemsById = new Map(
    items.map(item => [Number(item.id), item])
  )
  const result = new Map()

  for (const row of activeEmbeddingRows(items, config)) {
    const item = itemsById.get(Number(row.memory_id))
    if (!item) continue

    const source = memoryEmbeddingSource(item)
    if (sha256Text(source) !== row.source_sha256) {
      continue
    }

    try {
      result.set(
        Number(row.memory_id),
        decodeEmbedding(row.vector, config.dimensions)
      )
    } catch {
      // Corrupt rows are ignored and replaced by the next refresh/backfill.
    }
  }

  return result
}

const upsertEmbedding = db.prepare(`
  INSERT INTO memory_embeddings (
    memory_id,
    model,
    dimensions,
    source_sha256,
    vector
  )
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (
    memory_id,
    model,
    dimensions
  ) DO UPDATE SET
    source_sha256 = excluded.source_sha256,
    vector = excluded.vector,
    updated_at = unixepoch()
`)

const storeEmbeddingBatch = db.transaction(rows => {
  for (const row of rows) {
    upsertEmbedding.run(
      row.memoryId,
      row.model,
      row.dimensions,
      row.sourceSha256,
      row.vector
    )
  }
})

export async function ensureMemoryEmbeddings(
  items,
  {
    signal,
    fetchImpl = globalThis.fetch,
    force = false
  } = {}
) {
  const config = memoryEmbeddingConfig()

  if (!config.enabled) {
    return {
      indexed: 0,
      skipped: Array.isArray(items) ? items.length : 0,
      reason: 'disabled'
    }
  }

  if (Date.now() < circuitOpenUntil) {
    return {
      indexed: 0,
      skipped: Array.isArray(items) ? items.length : 0,
      reason: 'circuit_open'
    }
  }

  const candidates = (Array.isArray(items) ? items : [])
    .filter(item =>
      Number.isInteger(Number(item?.id)) &&
      item?.status !== 'archived' &&
      item?.status !== 'superseded' &&
      item?.type !== 'legacy' &&
      String(item?.content || '').trim()
    )

  const existing = force
    ? new Map()
    : currentRowsByMemoryId(candidates, config)

  const missing = candidates.filter(item =>
    !existing.has(Number(item.id))
  )

  if (!missing.length) {
    return {
      indexed: 0,
      skipped: candidates.length,
      reason: 'current'
    }
  }

  const client = clientFor(config, fetchImpl)
  let indexed = 0

  try {
    for (let offset = 0; offset < missing.length; offset += 32) {
      const batch = missing.slice(offset, offset + 32)
      const sources = batch.map(memoryEmbeddingSource)
      const vectors = await client.embed(sources, { signal })

      storeEmbeddingBatch(
        batch.map((item, index) => ({
          memoryId: Number(item.id),
          model: config.model,
          dimensions: config.dimensions,
          sourceSha256: sha256Text(sources[index]),
          vector: encodeEmbedding(vectors[index])
        }))
      )

      indexed += batch.length
    }

    closeCircuit()

    return {
      indexed,
      skipped: candidates.length - indexed,
      reason: 'success'
    }
  } catch (error) {
    openCircuit(config, error)

    return {
      indexed,
      skipped: candidates.length - indexed,
      reason: 'fallback',
      error: error?.message || String(error)
    }
  }
}

export async function refreshMemoryEmbeddingsByIds(
  userId,
  itemIds,
  options = {}
) {
  const ids = [...new Set(
    (Array.isArray(itemIds) ? itemIds : [])
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isInteger(value) && value > 0)
  )]

  if (!ids.length) {
    return {
      indexed: 0,
      skipped: 0,
      reason: 'empty'
    }
  }

  const placeholders = ids.map(() => '?').join(', ')
  const items = db.prepare(`
    SELECT
      id,
      type,
      scope,
      content,
      status
    FROM memory_items
    WHERE user_id = ?
      AND id IN (${placeholders})
      AND status = 'active'
      AND type <> 'legacy'
  `).all(userId, ...ids)

  return ensureMemoryEmbeddings(items, options)
}

export async function semanticScoresForMemoryItems(
  items,
  query,
  {
    recentContext = '',
    signal,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const config = memoryEmbeddingConfig()

  if (
    !config.enabled ||
    !String(query || '').trim() ||
    Date.now() < circuitOpenUntil
  ) {
    return new Map()
  }

  const refresh = await ensureMemoryEmbeddings(
    items,
    { signal, fetchImpl }
  )

  if (
    refresh.reason === 'fallback' ||
    refresh.reason === 'circuit_open'
  ) {
    return new Map()
  }

  const stored = currentRowsByMemoryId(items, config)
  if (!stored.size) {
    return new Map()
  }

  try {
    const client = clientFor(config, fetchImpl)
    const [queryVector] = await client.embed([
      memoryEmbeddingQuery(query, recentContext)
    ], { signal })

    const scores = new Map()

    for (const [memoryId, vector] of stored) {
      scores.set(
        memoryId,
        cosineSimilarity(queryVector, vector)
      )
    }

    closeCircuit()
    return scores
  } catch (error) {
    openCircuit(config, error)
    return new Map()
  }
}

export async function backfillMemoryEmbeddings({
  userId = null,
  force = false,
  signal,
  fetchImpl = globalThis.fetch,
  onProgress = () => {}
} = {}) {
  const conditions = [
    "status = 'active'",
    "type <> 'legacy'"
  ]
  const values = []

  if (Number.isInteger(Number(userId)) && Number(userId) > 0) {
    conditions.push('user_id = ?')
    values.push(Number(userId))
  }

  const items = db.prepare(`
    SELECT
      id,
      type,
      scope,
      content,
      status
    FROM memory_items
    WHERE ${conditions.join(' AND ')}
    ORDER BY id
  `).all(...values)

  let indexed = 0
  let skipped = 0

  for (let offset = 0; offset < items.length; offset += 32) {
    const result = await ensureMemoryEmbeddings(
      items.slice(offset, offset + 32),
      { signal, fetchImpl, force }
    )

    indexed += result.indexed
    skipped += result.skipped

    onProgress({
      processed: Math.min(offset + 32, items.length),
      total: items.length,
      indexed,
      skipped,
      reason: result.reason
    })

    if (result.reason === 'fallback' || result.reason === 'circuit_open') {
      return {
        ok: false,
        total: items.length,
        indexed,
        skipped,
        reason: result.reason,
        error: result.error || null
      }
    }
  }

  return {
    ok: true,
    total: items.length,
    indexed,
    skipped,
    reason: 'success'
  }
}
