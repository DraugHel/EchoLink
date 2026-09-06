import {
  hashChatHistorySource,
  readCurrentChatHistorySource
} from './chatHistorySearch.js'
import { redactSummarySecrets } from './conversationSummary.js'

const MAX_SOURCES = 24
const SOURCE_LABEL_RE = /\[H(\d+)\]/g

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function selectCitedChatHistorySources(content, catalog) {
  const map = catalog instanceof Map ? catalog : new Map()
  const output = []
  const seen = new Set()
  for (const match of String(content || '').matchAll(SOURCE_LABEL_RE)) {
    const label = `H${match[1]}`
    if (seen.has(label)) continue
    const source = map.get(label)
    if (!source) continue
    output.push({
      label,
      conversationId: source.conversationId,
      messageId: source.messageId,
      createdAt: source.createdAt,
      sourceHash: source.sourceHash
    })
    seen.add(label)
    if (output.length >= MAX_SOURCES) break
  }
  return output
}

export function serializeChatHistorySources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return ''
  return JSON.stringify(sources.slice(0, MAX_SOURCES))
}

export function parseStoredChatHistorySources(raw) {
  if (!raw) return []
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.slice(0, MAX_SOURCES).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    if (!/^H\d+$/.test(String(item.label || ''))) return []
    if (!Number.isInteger(item.conversationId) || item.conversationId <= 0) return []
    if (!Number.isInteger(item.messageId) || item.messageId <= 0) return []
    if (!Number.isInteger(item.createdAt) || item.createdAt <= 0) return []
    if (!validSha256(item.sourceHash)) return []
    return [{
      label: String(item.label),
      conversationId: item.conversationId,
      messageId: item.messageId,
      createdAt: item.createdAt,
      sourceHash: item.sourceHash
    }]
  })
}

export function resolveStoredChatHistorySources(db, userId, raw) {
  return parseStoredChatHistorySources(raw).map(source => {
    const row = readCurrentChatHistorySource(
      db,
      userId,
      source.conversationId,
      source.messageId
    )
    if (!row) {
      return {
        ...source,
        status: 'unavailable',
        title: '',
        role: '',
        createdAt: source.createdAt,
        archived: false
      }
    }
    const currentHash = hashChatHistorySource(row)
    return {
      ...source,
      status: currentHash === source.sourceHash
        ? 'available'
        : 'changed',
      title: redactSummarySecrets(
        String(row.conversation_title || '')
      ).slice(0, 300),
      role: row.role,
      createdAt: Number(row.created_at),
      archived: row.archived_at != null
    }
  })
}
