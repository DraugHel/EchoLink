import { createHash } from 'node:crypto'
import { redactSummarySecrets } from './conversationSummary.js'

const SEARCH_KEYS = new Set([
  'query',
  'conversation_id',
  'date_from',
  'date_to',
  'include_archived',
  'limit'
])
const READ_KEYS = new Set([
  'conversation_id',
  'message_id',
  'before',
  'after'
])
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

export class ChatHistoryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message)
    this.name = 'ChatHistoryError'
    this.code = code
    this.statusCode = statusCode
  }
}

function assertPlainObject(value, label = 'Argumente') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      `${label} müssen ein Objekt sein.`
    )
  }
}

function assertKnownKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ChatHistoryError(
        'CHAT_HISTORY_UNKNOWN_FIELD',
        `Unbekanntes Feld: ${key}`
      )
    }
  }
}

function positiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      `${field} muss eine ganze Zahl zwischen ${min} und ${max} sein.`
    )
  }
  return value
}

function optionalTimestamp(value, field) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      `${field} muss ein ISO-8601-Zeitpunkt mit Zeitzone sein.`
    )
  }
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      `${field} ist kein gültiger Zeitpunkt.`
    )
  }
  return {
    iso: new Date(millis).toISOString(),
    unix: Math.floor(millis / 1000)
  }
}

export function normalizeChatHistoryTerms(input) {
  if (typeof input !== 'string') {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      'query muss ein String sein.'
    )
  }
  const query = input.trim()
  if (query.length < 2 || query.length > 300) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      'query muss 2 bis 300 Zeichen lang sein.'
    )
  }
  const terms = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_]+/gu) || []
  if (terms.length === 0) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      'query enthält keine durchsuchbaren Begriffe.'
    )
  }
  if (terms.length > 8) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      'query darf höchstens 8 Suchbegriffe enthalten.'
    )
  }
  return {
    query,
    terms,
    ftsQuery: terms
      .map(term => `"${term.replaceAll('"', '""')}"*`)
      .join(' AND ')
  }
}

export function buildMessageSearchQuery(input) {
  return normalizeChatHistoryTerms(input).ftsQuery
}

export function normalizeSearchChatHistoryArgs(args) {
  assertPlainObject(args)
  assertKnownKeys(args, SEARCH_KEYS)

  const normalizedQuery = normalizeChatHistoryTerms(args.query)
  const conversationId = args.conversation_id === undefined
    ? null
    : positiveInteger(args.conversation_id, 'conversation_id')
  const dateFrom = optionalTimestamp(args.date_from, 'date_from')
  const dateTo = optionalTimestamp(args.date_to, 'date_to')

  if (dateFrom && dateTo && dateFrom.unix >= dateTo.unix) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      'date_from muss vor date_to liegen.'
    )
  }

  if (
    args.include_archived !== undefined &&
    typeof args.include_archived !== 'boolean'
  ) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_INVALID_ARGUMENTS',
      'include_archived muss true oder false sein.'
    )
  }

  const limit = args.limit === undefined
    ? 5
    : positiveInteger(args.limit, 'limit', { min: 1, max: 10 })

  return {
    query: normalizedQuery.query,
    terms: normalizedQuery.terms,
    ftsQuery: normalizedQuery.ftsQuery,
    conversationId,
    dateFrom,
    dateTo,
    includeArchived: args.include_archived ?? true,
    limit
  }
}

export function normalizeReadChatExcerptArgs(args) {
  assertPlainObject(args)
  assertKnownKeys(args, READ_KEYS)

  return {
    conversationId: positiveInteger(args.conversation_id, 'conversation_id'),
    messageId: positiveInteger(args.message_id, 'message_id'),
    before: args.before === undefined
      ? 3
      : positiveInteger(args.before, 'before', { min: 0, max: 5 }),
    after: args.after === undefined
      ? 3
      : positiveInteger(args.after, 'after', { min: 0, max: 5 })
  }
}

function neutralNotFound() {
  return new ChatHistoryError(
    'CHAT_HISTORY_NOT_FOUND',
    'Chat oder Nachricht nicht gefunden.',
    404
  )
}

function ensureConversationOwnership(db, userId, conversationId) {
  const row = db.prepare(`
    SELECT id
    FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(conversationId, userId)
  if (!row) throw neutralNotFound()
}

function mapSearchRow(row) {
  return {
    conversationId: Number(row.conversation_id),
    messageId: Number(row.message_id),
    title: redactSummarySecrets(String(row.conversation_title || '')).slice(0, 300),
    archived: row.archived_at != null,
    role: row.role,
    createdAt: Number(row.created_at),
    snippet: redactSummarySecrets(String(row.snippet || '')).slice(0, 900),
    score: Number(row.score),
    sourceHash: hashChatHistorySource({
      ...row,
      id: row.message_id
    })
  }
}

export function searchChatHistory(db, userId, args, {
  excludedMessageId = null
} = {}) {
  const normalized = normalizeSearchChatHistoryArgs(args)
  const ownerId = positiveInteger(userId, 'userId')

  if (normalized.conversationId != null) {
    ensureConversationOwnership(db, ownerId, normalized.conversationId)
  }

  const where = [
    'message_search MATCH ?',
    'conversations.user_id = ?'
  ]
  const params = [normalized.ftsQuery, ownerId]

  if (normalized.conversationId != null) {
    where.push('conversations.id = ?')
    params.push(normalized.conversationId)
  }
  if (!normalized.includeArchived) {
    where.push('conversations.archived_at IS NULL')
  }
  if (normalized.dateFrom) {
    where.push('messages.created_at >= ?')
    params.push(normalized.dateFrom.unix)
  }
  if (normalized.dateTo) {
    where.push('messages.created_at < ?')
    params.push(normalized.dateTo.unix)
  }
  if (excludedMessageId != null) {
    const excluded = positiveInteger(excludedMessageId, 'excludedMessageId')
    where.push('messages.id <> ?')
    params.push(excluded)
  }

  // Fetch a small bounded candidate pool, then diversify per conversation.
  const candidateLimit = Math.min(80, Math.max(24, normalized.limit * 8))
  let rows
  try {
    rows = db.prepare(`
      SELECT
        CAST(message_search.message_id AS INTEGER) AS message_id,
        messages.conversation_id,
        messages.role,
        messages.content,
        messages.images,
        messages.created_at,
        conversations.title AS conversation_title,
        conversations.archived_at,
        snippet(message_search, 1, '', '', ' … ', 24) AS snippet,
        bm25(message_search) AS score
      FROM message_search
      JOIN messages
        ON messages.id = CAST(message_search.message_id AS INTEGER)
      JOIN conversations
        ON conversations.id = messages.conversation_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY
        score ASC,
        messages.created_at DESC,
        messages.id DESC
      LIMIT ?
    `).all(...params, candidateLimit + 1)
  } catch (error) {
    throw new ChatHistoryError(
      'CHAT_HISTORY_FTS_UNAVAILABLE',
      `Chat-Volltextsuche ist nicht verfügbar: ${String(error?.message || error).slice(0, 180)}`,
      503
    )
  }

  const perConversation = new Map()
  const diversified = []
  for (const row of rows) {
    const conversationId = Number(row.conversation_id)
    const count = perConversation.get(conversationId) || 0
    if (count >= 2) continue
    perConversation.set(conversationId, count + 1)
    diversified.push(mapSearchRow(row))
    if (diversified.length > normalized.limit) break
  }

  const hasMore =
    diversified.length > normalized.limit ||
    rows.length > candidateLimit

  return {
    query: normalized.query,
    filters: {
      conversationId: normalized.conversationId,
      dateFrom: normalized.dateFrom?.iso || null,
      dateTo: normalized.dateTo?.iso || null,
      includeArchived: normalized.includeArchived
    },
    results: diversified.slice(0, normalized.limit),
    hasMore
  }
}

function parseAttachmentNames(raw) {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 3).map(item => {
      if (typeof item === 'string') return redactSummarySecrets(item).slice(0, 120)
      if (!item || typeof item !== 'object') return null
      const name = item.originalName || item.filename
      return typeof name === 'string'
        ? redactSummarySecrets(name).slice(0, 120)
        : null
    }).filter(Boolean)
  } catch {
    return []
  }
}

export function hashChatHistorySource(row) {
  return createHash('sha256')
    .update(JSON.stringify({
      conversationId: Number(row.conversation_id ?? row.conversationId),
      messageId: Number(row.id ?? row.message_id ?? row.messageId),
      role: String(row.role || ''),
      createdAt: Number(row.created_at ?? row.createdAt),
      content: String(row.content || ''),
      attachments: parseRawAttachmentNames(row.images)
    }))
    .digest('hex')
}

function parseRawAttachmentNames(raw) {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 10).map(item => {
      if (typeof item === 'string') return item.slice(0, 255)
      if (!item || typeof item !== 'object') return null
      const name = item.originalName || item.filename
      return typeof name === 'string' ? name.slice(0, 255) : null
    }).filter(Boolean)
  } catch {
    return []
  }
}

function truncateVisibleContent(value, limit) {
  const source = redactSummarySecrets(String(value || ''))
  if (source.length <= limit) {
    return { content: source, truncated: false }
  }
  if (limit <= 20) {
    return { content: source.slice(0, Math.max(0, limit)), truncated: true }
  }
  return {
    content: source.slice(0, limit - 16) + '\n…[gekürzt]',
    truncated: true
  }
}

function mapExcerptRow(row, contentBudget) {
  const text = truncateVisibleContent(row.content, Math.min(4_000, contentBudget))
  return {
    id: Number(row.id),
    role: row.role,
    createdAt: Number(row.created_at),
    content: text.content,
    truncated: text.truncated,
    attachmentNames: parseAttachmentNames(row.images),
    sourceHash: hashChatHistorySource(row)
  }
}

export function readChatExcerpt(db, userId, args, {
  maxResultChars = 12_000
} = {}) {
  const normalized = normalizeReadChatExcerptArgs(args)
  const ownerId = positiveInteger(userId, 'userId')
  ensureConversationOwnership(db, ownerId, normalized.conversationId)

  const center = db.prepare(`
    SELECT
      messages.id,
      messages.conversation_id,
      messages.role,
      messages.content,
      messages.images,
      messages.created_at,
      conversations.title AS conversation_title,
      conversations.archived_at
    FROM messages
    JOIN conversations
      ON conversations.id = messages.conversation_id
    WHERE messages.id = ?
      AND messages.conversation_id = ?
      AND conversations.user_id = ?
  `).get(
    normalized.messageId,
    normalized.conversationId,
    ownerId
  )

  if (!center) throw neutralNotFound()

  const beforeRows = normalized.before === 0 ? [] : db.prepare(`
    SELECT id, conversation_id, role, content, images, created_at
    FROM messages
    WHERE conversation_id = ? AND id < ?
    ORDER BY id DESC
    LIMIT ?
  `).all(normalized.conversationId, center.id, normalized.before).reverse()

  const afterRows = normalized.after === 0 ? [] : db.prepare(`
    SELECT id, conversation_id, role, content, images, created_at
    FROM messages
    WHERE conversation_id = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(normalized.conversationId, center.id, normalized.after)

  const neighborRows = [...beforeRows, ...afterRows]
  // Center first for budgeting; neighbors share the remainder. This prevents
  // old neighbors from consuming the budget before the actual hit.
  const metadataReserve = 1_600
  const contentBudget = Math.max(1_200, Math.min(10_400, maxResultChars - metadataReserve))
  const centerBudget = Math.min(4_000, Math.max(1_200, Math.floor(contentBudget * 0.38)))
  const remaining = Math.max(0, contentBudget - centerBudget)
  const neighborBudget = neighborRows.length
    ? Math.min(4_000, Math.max(300, Math.floor(remaining / neighborRows.length)))
    : 0

  const mappedCenter = mapExcerptRow(center, centerBudget)
  const mappedBefore = beforeRows.map(row => mapExcerptRow(row, neighborBudget))
  const mappedAfter = afterRows.map(row => mapExcerptRow(row, neighborBudget))

  return {
    conversation: {
      id: normalized.conversationId,
      title: redactSummarySecrets(String(center.conversation_title || '')).slice(0, 300),
      archived: center.archived_at != null
    },
    centerMessageId: normalized.messageId,
    messages: [...mappedBefore, mappedCenter, ...mappedAfter],
    limits: {
      maxMessages: 11,
      maxCharsPerMessage: 4_000,
      maxResultChars
    }
  }
}

export function readCurrentChatHistorySource(db, userId, conversationId, messageId) {
  const ownerId = positiveInteger(userId, 'userId')
  const convoId = positiveInteger(conversationId, 'conversationId')
  const msgId = positiveInteger(messageId, 'messageId')
  return db.prepare(`
    SELECT
      messages.id,
      messages.conversation_id,
      messages.role,
      messages.content,
      messages.images,
      messages.created_at,
      conversations.title AS conversation_title,
      conversations.archived_at
    FROM messages
    JOIN conversations
      ON conversations.id = messages.conversation_id
    WHERE messages.id = ?
      AND messages.conversation_id = ?
      AND conversations.user_id = ?
  `).get(msgId, convoId, ownerId) || null
}
