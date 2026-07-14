import db from '../db.js'

export const MEMORY_TYPES = new Set([
  'profile',
  'preference',
  'project',
  'instruction',
  'episodic',
  'temporary',
  'persona',
  'legacy',
  'fact'
])

export const MEMORY_STATUSES = new Set([
  'active',
  'superseded',
  'archived'
])

function apiError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function requiredUserId(value) {
  const id = Number.parseInt(value, 10)

  if (!Number.isInteger(id) || id < 1) {
    throw apiError('Ungültige userId')
  }

  return id
}

function requiredItemId(value) {
  const id = Number.parseInt(value, 10)

  if (!Number.isInteger(id) || id < 1) {
    throw apiError('Ungültige Memory-ID')
  }

  return id
}

function optionalInteger(value, name) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return null
  }

  const parsed = Number.parseInt(value, 10)

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw apiError(`${name} ist ungültig`)
  }

  return parsed
}

function normalizeType(value = 'fact') {
  const type = String(value || '').trim()

  if (!MEMORY_TYPES.has(type)) {
    throw apiError(
      `Ungültiger Memory-Typ: ${type}`
    )
  }

  return type
}

function normalizeStatus(value = 'active') {
  const status = String(value || '').trim()

  if (!MEMORY_STATUSES.has(status)) {
    throw apiError(
      `Ungültiger Memory-Status: ${status}`
    )
  }

  return status
}

function normalizeScope(value = 'global') {
  const scope =
    String(value || 'global').trim()

  if (
    !scope ||
    scope.length > 160 ||
    !/^[a-z][a-z0-9_-]*(?::[a-zA-Z0-9._-]+)?$/.test(
      scope
    )
  ) {
    throw apiError(
      'Scope ist ungültig'
    )
  }

  return scope
}

function normalizeContent(value) {
  if (typeof value !== 'string') {
    throw apiError(
      'Memory-Inhalt muss Text sein'
    )
  }

  const content = value.trim()

  if (!content) {
    throw apiError(
      'Memory-Inhalt darf nicht leer sein'
    )
  }

  if (content.length > 20000) {
    throw apiError(
      'Memory-Inhalt ist zu lang'
    )
  }

  return content
}

function normalizeConfidence(
  value = 1
) {
  const confidence = Number(value)

  if (
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw apiError(
      'confidence muss zwischen 0 und 1 liegen'
    )
  }

  return confidence
}

function normalizeImportance(
  value = 50
) {
  const importance =
    Number.parseInt(value, 10)

  if (
    !Number.isInteger(importance) ||
    importance < 0 ||
    importance > 100
  ) {
    throw apiError(
      'importance muss zwischen 0 und 100 liegen'
    )
  }

  return importance
}

function normalizeExpiresAt(value) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return null
  }

  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    const timestamp = Math.floor(value)

    if (timestamp < 1) {
      throw apiError(
        'expiresAt ist ungültig'
      )
    }

    return timestamp
  }

  const milliseconds =
    Date.parse(String(value))

  if (!Number.isFinite(milliseconds)) {
    throw apiError(
      'expiresAt muss ein ISO-Datum oder Unix-Timestamp sein'
    )
  }

  return Math.floor(
    milliseconds / 1000
  )
}

function normalizeMetadata(value = {}) {
  if (
    value === null ||
    value === undefined
  ) {
    return '{}'
  }

  if (
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw apiError(
      'metadata muss ein Objekt sein'
    )
  }

  const serialized =
    JSON.stringify(value)

  if (serialized.length > 10000) {
    throw apiError(
      'metadata ist zu groß'
    )
  }

  return serialized
}

function parseMetadata(value) {
  try {
    const parsed =
      JSON.parse(value || '{}')

    return (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    )
      ? parsed
      : {}
  } catch {
    return {}
  }
}

function mapItem(row) {
  if (!row) return null

  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    scope: row.scope,
    content: row.content,
    confidence: row.confidence,
    importance: row.importance,
    status: row.status,
    sourceConversationId:
      row.source_conversation_id,
    sourceMessageId:
      row.source_message_id,
    supersedesId:
      row.supersedes_id,
    createdAt:
      row.created_at,
    updatedAt:
      row.updated_at,
    lastConfirmedAt:
      row.last_confirmed_at,
    expiresAt:
      row.expires_at,
    metadata:
      parseMetadata(row.metadata)
  }
}

export function getMemoryItem(
  userId,
  itemId
) {
  const row = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE id = ?
      AND user_id = ?
  `).get(
    requiredItemId(itemId),
    requiredUserId(userId)
  )

  return mapItem(row)
}

export function listMemoryItems(
  userId,
  filters = {}
) {
  const conditions = [
    'user_id = ?'
  ]

  const values = [
    requiredUserId(userId)
  ]

  if (
    filters.status &&
    filters.status !== 'all'
  ) {
    conditions.push('status = ?')
    values.push(
      normalizeStatus(filters.status)
    )
  }

  if (filters.type) {
    conditions.push('type = ?')
    values.push(
      normalizeType(filters.type)
    )
  }

  if (filters.scope) {
    conditions.push('scope = ?')
    values.push(
      normalizeScope(filters.scope)
    )
  }

  const parsedLimit =
    Number.parseInt(filters.limit, 10)

  const limit =
    Number.isInteger(parsedLimit)
      ? Math.min(
          Math.max(parsedLimit, 1),
          200
        )
      : 100

  const rows = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'superseded' THEN 1
        ELSE 2
      END,
      importance DESC,
      updated_at DESC,
      id DESC
    LIMIT ?
  `).all(
    ...values,
    limit
  )

  return rows.map(mapItem)
}

export function createMemoryItem(
  userId,
  input = {}
) {
  const cleanUserId =
    requiredUserId(userId)

  const supersedesId =
    optionalInteger(
      input.supersedesId,
      'supersedesId'
    )

  const sourceConversationId =
    optionalInteger(
      input.sourceConversationId,
      'sourceConversationId'
    )

  const sourceMessageId =
    optionalInteger(
      input.sourceMessageId,
      'sourceMessageId'
    )

  const transaction =
    db.transaction(() => {
      if (supersedesId) {
        const previous =
          getMemoryItem(
            cleanUserId,
            supersedesId
          )

        if (!previous) {
          throw apiError(
            'Zu ersetzende Memory wurde nicht gefunden',
            404
          )
        }
      }

      const result = db.prepare(`
        INSERT INTO memory_items (
          user_id,
          type,
          scope,
          content,
          confidence,
          importance,
          status,
          source_conversation_id,
          source_message_id,
          supersedes_id,
          last_confirmed_at,
          expires_at,
          metadata
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
      `).run(
        cleanUserId,
        normalizeType(input.type),
        normalizeScope(input.scope),
        normalizeContent(input.content),
        normalizeConfidence(
          input.confidence
        ),
        normalizeImportance(
          input.importance
        ),
        normalizeStatus(input.status),
        sourceConversationId,
        sourceMessageId,
        supersedesId,
        input.lastConfirmedAt === null
          ? null
          : (
              optionalInteger(
                input.lastConfirmedAt,
                'lastConfirmedAt'
              ) ||
              Math.floor(Date.now() / 1000)
            ),
        normalizeExpiresAt(
          input.expiresAt
        ),
        normalizeMetadata(
          input.metadata
        )
      )

      const newId =
        Number(result.lastInsertRowid)

      if (supersedesId) {
        db.prepare(`
          UPDATE memory_items
          SET status = 'superseded',
              updated_at = unixepoch()
          WHERE id = ?
            AND user_id = ?
        `).run(
          supersedesId,
          cleanUserId
        )
      }

      return getMemoryItem(
        cleanUserId,
        newId
      )
    })

  return transaction()
}

export function updateMemoryItem(
  userId,
  itemId,
  input = {}
) {
  const cleanUserId =
    requiredUserId(userId)

  const cleanItemId =
    requiredItemId(itemId)

  if (
    !getMemoryItem(
      cleanUserId,
      cleanItemId
    )
  ) {
    throw apiError(
      'Memory wurde nicht gefunden',
      404
    )
  }

  const fields = []
  const values = []

  if ('type' in input) {
    fields.push('type = ?')
    values.push(
      normalizeType(input.type)
    )
  }

  if ('scope' in input) {
    fields.push('scope = ?')
    values.push(
      normalizeScope(input.scope)
    )
  }

  if ('content' in input) {
    fields.push('content = ?')
    values.push(
      normalizeContent(input.content)
    )
  }

  if ('confidence' in input) {
    fields.push('confidence = ?')
    values.push(
      normalizeConfidence(
        input.confidence
      )
    )
  }

  if ('importance' in input) {
    fields.push('importance = ?')
    values.push(
      normalizeImportance(
        input.importance
      )
    )
  }

  if ('status' in input) {
    fields.push('status = ?')
    values.push(
      normalizeStatus(input.status)
    )
  }

  if ('expiresAt' in input) {
    fields.push('expires_at = ?')
    values.push(
      normalizeExpiresAt(
        input.expiresAt
      )
    )
  }

  if ('metadata' in input) {
    fields.push('metadata = ?')
    values.push(
      normalizeMetadata(
        input.metadata
      )
    )
  }

  if (input.confirm === true) {
    fields.push(
      'last_confirmed_at = unixepoch()'
    )
  }

  if (!fields.length) {
    throw apiError(
      'Keine Änderungen angegeben'
    )
  }

  fields.push(
    'updated_at = unixepoch()'
  )

  db.prepare(`
    UPDATE memory_items
    SET ${fields.join(', ')}
    WHERE id = ?
      AND user_id = ?
  `).run(
    ...values,
    cleanItemId,
    cleanUserId
  )

  return getMemoryItem(
    cleanUserId,
    cleanItemId
  )
}

export function archiveMemoryItem(
  userId,
  itemId
) {
  return updateMemoryItem(
    userId,
    itemId,
    {
      status: 'archived'
    }
  )
}

export function deleteMemoryItem(
  userId,
  itemId
) {
  const result = db.prepare(`
    DELETE FROM memory_items
    WHERE id = ?
      AND user_id = ?
  `).run(
    requiredItemId(itemId),
    requiredUserId(userId)
  )

  if (!result.changes) {
    throw apiError(
      'Memory wurde nicht gefunden',
      404
    )
  }

  return {
    ok: true
  }
}

const MEMORY_STOPWORDS = new Set([
  'aber',
  'alle',
  'auch',
  'aus',
  'bei',
  'das',
  'dass',
  'dem',
  'den',
  'der',
  'des',
  'die',
  'ein',
  'eine',
  'einer',
  'eines',
  'für',
  'fur',
  'hat',
  'ich',
  'ist',
  'mit',
  'nicht',
  'oder',
  'sich',
  'sind',
  'und',
  'von',
  'was',
  'wie',
  'wird',
  'the',
  'this',
  'that',
  'with',
  'from',
  'have',
  'what'
])

function memoryTokens(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')

  const matches =
    normalized.match(
      /[\p{L}\p{N}][\p{L}\p{N}._-]+/gu
    ) || []

  return [
    ...new Set(
      matches.filter(token =>
        token.length >= 3 &&
        !MEMORY_STOPWORDS.has(token)
      )
    )
  ]
}

function memoryRetrievalScore(
  item,
  queryTokens,
  conversationId
) {
  const text = String(item.content || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')

  const scopeToken = item.scope.startsWith('project:')
    ? item.scope.slice('project:'.length).toLowerCase()
    : item.scope.startsWith('persona:')
      ? item.scope.slice('persona:'.length).toLowerCase()
      : ''

  const relevantQueryTokens = scopeToken
    ? queryTokens.filter(token => token !== scopeToken)
    : queryTokens

  const overlap = relevantQueryTokens.filter(
    token => text.includes(token)
  ).length

  const conversationScope =
    `conversation:${conversationId}`

  const exactConversation =
    item.scope === conversationScope

  const globalStanding =
    item.scope === 'global' &&
    item.type === 'instruction' &&
    item.metadata?.alwaysInclude === true

  // Projekt-, Persona- und normale Fakten nur laden,
  // wenn sie tatsächlich zur aktuellen Frage passen.
  if (
    overlap === 0 &&
    !exactConversation &&
    !globalStanding
  ) {
    return -1000
  }

  let score =
    overlap * 20 +
    Number(item.importance || 0) * 0.25 +
    Number(item.confidence || 0) * 10

  if (exactConversation) {
    score += 50
  }

  if (globalStanding) {
    score += 20
  }

  if (
    item.scope.startsWith('project:') &&
    overlap > 0
  ) {
    score += 6
  }

  if (
    item.scope.startsWith('persona:') &&
    overlap > 0
  ) {
    score += 6
  }

  const ageSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) -
      Number(item.updatedAt || 0)
  )

  if (ageSeconds < 30 * 86400) {
    score += 3
  } else if (ageSeconds < 180 * 86400) {
    score += 1
  }

  return score
}

export function selectMemoryItemsForContext(
  userId,
  query,
  options = {}
) {
  const cleanUserId =
    requiredUserId(userId)

  const conversationId =
    Number.parseInt(
      options.conversationId,
      10
    ) || 0

  const limit =
    Math.min(
      Math.max(
        Number.parseInt(
          options.limit,
          10
        ) || 10,
        1
      ),
      30
    )

  const maxChars =
    Math.min(
      Math.max(
        Number.parseInt(
          options.maxChars,
          10
        ) || 6000,
        500
      ),
      20000
    )

  const rows = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE user_id = ?
      AND status = 'active'
      AND type <> 'legacy'
      AND (
        expires_at IS NULL
        OR expires_at > unixepoch()
      )
    ORDER BY
      importance DESC,
      updated_at DESC
    LIMIT 250
  `).all(cleanUserId)

  const queryTokens =
    memoryTokens(query)

  const ranked = rows
    .map(row => {
      const item = mapItem(row)

      return {
        ...item,
        retrievalScore:
          memoryRetrievalScore(
            item,
            queryTokens,
            conversationId
          )
      }
    })
    .filter(
      item =>
        item.retrievalScore >= 18
    )
    .sort(
      (a, b) =>
        b.retrievalScore -
          a.retrievalScore ||
        b.importance -
          a.importance ||
        b.updatedAt -
          a.updatedAt
    )

  const selected = []
  let characters = 0

  for (const item of ranked) {
    if (selected.length >= limit) {
      break
    }

    const itemLength =
      item.content.length + 100

    if (
      selected.length > 0 &&
      characters + itemLength >
        maxChars
    ) {
      continue
    }

    selected.push(item)
    characters += itemLength
  }

  return selected
}

export function formatMemoryItemsForPrompt(
  items
) {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return ''
  }

  return items
    .map(item => {
      const details = [
        `type=${item.type}`,
        `scope=${item.scope}`,
        `importance=${item.importance}`,
        `confidence=${Number(
          item.confidence
        ).toFixed(2)}`,
        `id=${item.id}`
      ].join('; ')

      return `- [${details}] ${item.content}`
    })
    .join('\n')
}
