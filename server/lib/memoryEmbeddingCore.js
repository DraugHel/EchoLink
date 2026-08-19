import crypto from 'node:crypto'

const QUERY_PREFIX =
  'task: search result | query: '

const DOCUMENT_PREFIX =
  'title: none | text: '

export function memoryEmbeddingSource(item) {
  const type = String(item?.type || 'fact').trim()
  const scope = String(item?.scope || 'global').trim()
  const content = String(item?.content || '').trim()

  return `${DOCUMENT_PREFIX}[type=${type}; scope=${scope}] ${content}`
}

export function memoryEmbeddingQuery(query, recentContext = '') {
  const current = String(query || '').trim()
  const context = String(recentContext || '').trim()
  const words = current.match(/[\p{L}\p{N}]+/gu) || []
  const needsContext =
    context &&
    (current.length < 120 || words.length < 8)

  const text = needsContext
    ? `${current}\n\nRecent conversation context:\n${context}`
    : current

  return `${QUERY_PREFIX}${text}`
}

export function sha256Text(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
}

export function normalizeEmbedding(vector, expectedDimensions) {
  if (!Array.isArray(vector)) {
    throw new Error('Embedding vector is missing')
  }

  if (
    Number.isInteger(expectedDimensions) &&
    vector.length !== expectedDimensions
  ) {
    throw new Error(
      `Embedding dimensions mismatch: expected ${expectedDimensions}, got ${vector.length}`
    )
  }

  if (!vector.length || vector.length > 4096) {
    throw new Error('Embedding vector has invalid dimensions')
  }

  const values = vector.map(value => Number(value))
  let squaredNorm = 0

  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error('Embedding vector contains a non-finite value')
    }

    squaredNorm += value * value
  }

  if (!(squaredNorm > 0)) {
    throw new Error('Embedding vector has zero norm')
  }

  const norm = Math.sqrt(squaredNorm)

  return Float32Array.from(
    values,
    value => value / norm
  )
}

export function encodeEmbedding(vector) {
  if (!(vector instanceof Float32Array)) {
    throw new Error('Embedding must be normalized Float32Array data')
  }

  const buffer = Buffer.allocUnsafe(vector.length * 4)

  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index], index * 4)
  }

  return buffer
}

export function decodeEmbedding(buffer, expectedDimensions) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Stored embedding is not a Buffer')
  }

  if (
    buffer.length !== expectedDimensions * 4
  ) {
    throw new Error('Stored embedding has invalid byte length')
  }

  const vector = new Float32Array(expectedDimensions)

  for (let index = 0; index < expectedDimensions; index += 1) {
    vector[index] = buffer.readFloatLE(index * 4)
  }

  return vector
}

export function cosineSimilarity(left, right) {
  if (
    !(left instanceof Float32Array) ||
    !(right instanceof Float32Array) ||
    left.length !== right.length ||
    left.length === 0
  ) {
    throw new Error('Embedding vectors are incompatible')
  }

  let similarity = 0

  for (let index = 0; index < left.length; index += 1) {
    similarity += left[index] * right[index]
  }

  return Math.max(-1, Math.min(1, similarity))
}

export function hybridMemoryScore({
  lexicalScore,
  semanticSimilarity,
  semanticThreshold = 0.45,
  exactConversation = false,
  globalStanding = false
}) {
  const lexicalMatch =
    Number.isFinite(lexicalScore) &&
    lexicalScore >= 18

  const semanticMatch =
    Number.isFinite(semanticSimilarity) &&
    semanticSimilarity >= semanticThreshold

  if (
    !lexicalMatch &&
    !semanticMatch &&
    !exactConversation &&
    !globalStanding
  ) {
    return null
  }

  const lexical = lexicalMatch
    ? lexicalScore
    : 0

  const semantic = semanticMatch
    ? 30 +
      (
        (semanticSimilarity - semanticThreshold) /
        (1 - semanticThreshold)
      ) * 70
    : 0

  let score = Math.max(lexical, semantic)

  if (lexicalMatch && semanticMatch) {
    score += 10
  }

  if (exactConversation) {
    score += 50
  }

  if (globalStanding) {
    score += 35
  }

  return score
}

