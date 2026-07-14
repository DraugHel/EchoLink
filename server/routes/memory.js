import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db, { DEFAULT_MODEL } from '../db.js'
import {
  archiveMemoryItem,
  createMemoryItem,
  deleteMemoryItem,
  getMemoryItem,
  listMemoryItems,
  updateMemoryItem
} from '../lib/memoryItems.js'

const router = Router()
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'

const OPENAI_RESPONSES_URL =
  'https://api.openai.com/v1/responses'

const OPENAI_KEY =
  process.env.OPENAI_API_KEY || ''

function extractOpenAIText(data) {
  if (
    typeof data?.output_text === 'string' &&
    data.output_text.trim()
  ) {
    return data.output_text.trim()
  }

  const parts = []

  for (const item of data?.output || []) {
    if (item?.type !== 'message') continue

    for (const part of item.content || []) {
      if (
        part?.type === 'output_text' &&
        typeof part.text === 'string'
      ) {
        parts.push(part.text)
      }
    }
  }

  return parts.join('\n').trim()
}

async function fetchWithTimeout(
  url,
  options,
  timeoutMs = 120000
) {
  const controller = new AbortController()

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  )

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

async function runMemoryModel(
  model,
  prompt
) {
  const selectedModel =
    String(model || '').trim()

  if (!selectedModel) {
    throw new Error(
      'Kein Modell für Memory-Extraktion angegeben'
    )
  }

  if (
    selectedModel.startsWith('openai/')
  ) {
    if (!OPENAI_KEY) {
      throw new Error(
        'OPENAI_API_KEY fehlt'
      )
    }

    const apiModel =
      selectedModel.slice(7)

    const response =
      await fetchWithTimeout(
        OPENAI_RESPONSES_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${OPENAI_KEY}`
          },
          body: JSON.stringify({
            model: apiModel,
            store: false,
            input: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: prompt
                  }
                ]
              }
            ],
            max_output_tokens: 4000
          })
        }
      )

    const raw =
      await response.text()

    let data

    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(
        'OpenAI lieferte keine gültige JSON-Antwort'
      )
    }

    if (!response.ok || data?.error) {
      throw new Error(
        `OpenAI Memory ${response.status}: ` +
        String(
          data?.error?.message ||
          data?.error ||
          raw
        ).slice(0, 300)
      )
    }

    return extractOpenAIText(data)
  }

  const ollamaModel =
    selectedModel.startsWith('ollama/')
      ? selectedModel.slice(7)
      : selectedModel

  const response =
    await fetchWithTimeout(
      `${OLLAMA_URL}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          model: ollamaModel,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          stream: false,
          think: false,
          options: {
            temperature: 0.3,
            top_p: 0.9
          }
        })
      }
    )

  if (!response.ok) {
    const errorBody =
      await response.text()

    throw new Error(
      `Ollama Memory ${response.status}: ` +
      errorBody.slice(0, 300)
    )
  }

  const data =
    await response.json()

  return String(
    data?.message?.content || ''
  ).trim()
}


// Get current memory
router.get('/', requireAuth, (req, res) => {
  const user = db.prepare('SELECT memory FROM users WHERE id = ?').get(req.session.userId)
  res.json({ memory: user.memory || '' })
})

// Manually save edited memory
router.post('/save', requireAuth, (req, res) => {
  const content = req.body?.content

  if (typeof content !== 'string') {
    return res.status(400).json({
      error: 'Memory content must be a string'
    })
  }

  if (content.length > 500_000) {
    return res.status(400).json({
      error: 'Memory ist zu lang'
    })
  }

  db.prepare(
    'UPDATE users SET memory = ? WHERE id = ?'
  ).run(content, req.session.userId)

  res.json({
    ok: true,
    memory: content
  })
})

// Clear memory
router.delete('/', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET memory = ? WHERE id = ?').run('', req.session.userId)
  res.json({ ok: true })
})


function sendItemError(res, error) {
  const statusCode =
    Number.isInteger(error?.statusCode)
      ? error.statusCode
      : 500

  if (statusCode >= 500) {
    console.error(
      'Memory item error:',
      error?.message
    )
  }

  return res.status(statusCode).json({
    error:
      statusCode >= 500
        ? 'Memory-Aktion fehlgeschlagen'
        : error.message
  })
}

// Strukturierte Einzel-Memories anzeigen
router.get('/items', requireAuth, (req, res) => {
  try {
    const items = listMemoryItems(
      req.session.userId,
      {
        status:
          req.query.status || 'active',
        type:
          req.query.type,
        scope:
          req.query.scope,
        limit:
          req.query.limit
      }
    )

    res.json({
      items,
      count: items.length
    })
  } catch (error) {
    sendItemError(res, error)
  }
})

// Einzelne Memory anzeigen
router.get('/items/:itemId', requireAuth, (req, res) => {
  try {
    const item = getMemoryItem(
      req.session.userId,
      req.params.itemId
    )

    if (!item) {
      return res.status(404).json({
        error:
          'Memory wurde nicht gefunden'
      })
    }

    res.json({ item })
  } catch (error) {
    sendItemError(res, error)
  }
})

// Manuelle Einzel-Memory anlegen
router.post('/items', requireAuth, (req, res) => {
  try {
    const item = createMemoryItem(
      req.session.userId,
      {
        type:
          req.body?.type,
        scope:
          req.body?.scope,
        content:
          req.body?.content,
        confidence:
          req.body?.confidence,
        importance:
          req.body?.importance,
        expiresAt:
          req.body?.expiresAt,
        metadata:
          req.body?.metadata,
        supersedesId:
          req.body?.supersedesId
      }
    )

    res.status(201).json({
      ok: true,
      item
    })
  } catch (error) {
    sendItemError(res, error)
  }
})

// Einzelne Memory bearbeiten
router.patch('/items/:itemId', requireAuth, (req, res) => {
  try {
    const item = updateMemoryItem(
      req.session.userId,
      req.params.itemId,
      req.body || {}
    )

    res.json({
      ok: true,
      item
    })
  } catch (error) {
    sendItemError(res, error)
  }
})

// Einzelne Memory archivieren
router.post(
  '/items/:itemId/archive',
  requireAuth,
  (req, res) => {
    try {
      const item =
        archiveMemoryItem(
          req.session.userId,
          req.params.itemId
        )

      res.json({
        ok: true,
        item
      })
    } catch (error) {
      sendItemError(res, error)
    }
  }
)

// Einzelne Memory endgültig löschen
router.delete('/items/:itemId', requireAuth, (req, res) => {
  try {
    const result =
      deleteMemoryItem(
        req.session.userId,
        req.params.itemId
      )

    res.json(result)
  } catch (error) {
    sendItemError(res, error)
  }
})

function normalizeMemoryFingerprint(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const MEMORY_DUPLICATE_STOPWORDS = new Set([
  'aber', 'als', 'auch', 'bei', 'das', 'dass',
  'dem', 'den', 'der', 'die', 'ein', 'eine',
  'für', 'ich', 'ist', 'mit', 'nicht', 'oder',
  'sich', 'und', 'von', 'the', 'this', 'with'
])

function memoryDuplicateTokens(value) {
  return new Set(
    normalizeMemoryFingerprint(value)
      .split(/\s+/)
      .filter(token =>
        token.length >= 3 &&
        !MEMORY_DUPLICATE_STOPWORDS.has(token)
      )
  )
}

function memoryWordSimilarity(leftValue, rightValue) {
  const left = memoryDuplicateTokens(leftValue)
  const right = memoryDuplicateTokens(rightValue)

  if (!left.size || !right.size) return 0

  let overlap = 0

  for (const token of left) {
    if (right.has(token)) overlap += 1
  }

  const containment =
    overlap / Math.min(left.size, right.size)

  const union =
    left.size + right.size - overlap

  const jaccard =
    union > 0 ? overlap / union : 0

  return Math.max(
    jaccard,
    containment * 0.85
  )
}

function findSimilarMemory(items, candidate) {
  let best = null
  let bestScore = 0

  for (const item of items) {
    if (
      item.type !== candidate.type ||
      item.scope !== candidate.scope
    ) {
      continue
    }

    const score = memoryWordSimilarity(
      item.content,
      candidate.content
    )

    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }

  return bestScore >= 0.72
    ? best
    : null
}

function parseMemoryExtractionJson(rawValue) {
  let text = String(rawValue || '').trim()

  text = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')

  if (start < 0 || end <= start) {
    throw new Error('Memory-Modell lieferte kein JSON-Objekt')
  }

  const parsed = JSON.parse(text.slice(start, end + 1))

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Memory-Modell lieferte ungültiges JSON')
  }

  return parsed
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function applyStructuredMemories({
  userId,
  conversationId,
  sourceMessageId,
  extractorModel,
  candidates,
  activeItems
}) {
  const result = {
    created: 0,
    confirmed: 0,
    replaced: 0,
    archived: 0,
    skipped: 0,
    itemIds: []
  }

  const itemsById = new Map(activeItems.map(item => [item.id, item]))
  const itemsByFingerprint = new Map(
    activeItems.map(item => [normalizeMemoryFingerprint(item.content), item])
  )

  for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 8) : []) {
    try {
      if (!candidate || typeof candidate !== 'object') {
        result.skipped += 1
        continue
      }

      const action = String(candidate.action || 'create').trim().toLowerCase()
      const targetId = Number.parseInt(candidate.id, 10)

      if (action === 'confirm') {
        const existing = itemsById.get(targetId)
        if (!existing) {
          result.skipped += 1
          continue
        }

        updateMemoryItem(userId, existing.id, { confirm: true })
        result.confirmed += 1
        result.itemIds.push(existing.id)
        continue
      }

      if (action === 'archive') {
        const existing = itemsById.get(targetId)

        if (!existing) {
          result.skipped += 1
          continue
        }

        updateMemoryItem(userId, existing.id, {
          status: 'archived'
        })

        itemsById.delete(existing.id)
        result.archived += 1
        result.itemIds.push(existing.id)
        continue
      }

      if (action !== 'create' && action !== 'replace') {
        result.skipped += 1
        continue
      }

      const content = typeof candidate.content === 'string'
        ? candidate.content.trim()
        : ''

      if (!content || content.length > 20000) {
        result.skipped += 1
        continue
      }

      const type = String(candidate.type || 'fact').trim()
      const scope = String(candidate.scope || 'global').trim()
      const expiresAt = candidate.expiresAt || null

      if (type === 'temporary' && !expiresAt) {
        result.skipped += 1
        continue
      }

      const importance = Math.round(
        clampNumber(candidate.importance, 0, 100, 50)
      )

      const confidence = clampNumber(
        candidate.confidence,
        0,
        1,
        0.8
      )

      const fingerprint = normalizeMemoryFingerprint(content)
      const duplicate =
        itemsByFingerprint.get(fingerprint) ||
        findSimilarMemory(
          [...itemsById.values()],
          { type, scope, content }
        )

      if (duplicate && action !== 'replace') {
        updateMemoryItem(userId, duplicate.id, {
          confirm: true,
          importance: Math.max(duplicate.importance, importance),
          confidence: Math.max(duplicate.confidence, confidence)
        })

        result.confirmed += 1
        result.itemIds.push(duplicate.id)
        continue
      }

      if (action === 'replace') {
        const previous = itemsById.get(targetId)

        if (!previous) {
          result.skipped += 1
          continue
        }

        const created = createMemoryItem(userId, {
          type,
          scope,
          content,
          importance,
          confidence,
          expiresAt,
          supersedesId: previous.id,
          sourceConversationId: conversationId,
          sourceMessageId,
          metadata: {
            automaticallyExtracted: true,
            extractorModel,
            replacedMemoryId: previous.id
          }
        })

        itemsById.delete(previous.id)
        itemsById.set(created.id, created)
        itemsByFingerprint.set(fingerprint, created)

        result.replaced += 1
        result.itemIds.push(created.id)
        continue
      }

      const created = createMemoryItem(userId, {
        type,
        scope,
        content,
        importance,
        confidence,
        expiresAt,
        sourceConversationId: conversationId,
        sourceMessageId,
        metadata: {
          automaticallyExtracted: true,
          extractorModel
        }
      })

      itemsById.set(created.id, created)
      itemsByFingerprint.set(fingerprint, created)

      result.created += 1
      result.itemIds.push(created.id)
    } catch (error) {
      result.skipped += 1
      console.error('Structured memory candidate skipped:', error.message)
    }
  }

  return result
}

// Update memory from a conversation — called directly by chat.js or via HTTP
export async function extractMemory(userId, conversationId, model) {
  const convo = db.prepare(`
    SELECT *
    FROM conversations
    WHERE id = ?
      AND user_id = ?
  `).get(conversationId, userId)

  if (!convo) {
    return { ok: true, skipped: true, reason: 'conversation_not_found' }
  }

  const messages = db.prepare(`
    SELECT id, role, content
    FROM (
      SELECT id, role, content
      FROM messages
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT 40
    ) AS recent_messages
    ORDER BY id ASC
  `).all(conversationId)

  if (messages.length < 2) {
    return { ok: true, skipped: true, reason: 'not_enough_messages' }
  }

  const user = db.prepare(`
    SELECT memory
    FROM users
    WHERE id = ?
  `).get(userId)

  const existingMemory = user?.memory || ''

  const activeItems = listMemoryItems(userId, {
    status: 'active',
    limit: 200
  }).filter(item =>
    item.type !== 'legacy' &&
    (!item.expiresAt || item.expiresAt > Math.floor(Date.now() / 1000))
  )

  const transcript = messages
    .map(message => {
      const role = message.role === 'user' ? 'User' : 'Echo'
      return `[message ${message.id}] ${role}: ${String(message.content || '').slice(0, 800)}`
    })
    .join('\n')

  const structuredSummary = activeItems.length
    ? activeItems
        .slice(0, 100)
        .map(item => JSON.stringify({
          id: item.id,
          type: item.type,
          scope: item.scope,
          content: item.content.slice(0, 600),
          importance: item.importance,
          confidence: item.confidence
        }))
        .join('\n')
    : '(none)'

  const extractPrompt = `You are a memory extraction system.

Analyze the conversation and update two memory representations:

1. legacyMarkdown:
A concise backward-compatible user profile in Markdown.

2. memories:
Structured actions for individual durable memories.

Existing legacy Markdown:
---
${existingMemory.slice(0, 16000) || '(none)'}
---

Existing active structured memories:
---
${structuredSummary}
---

Conversation:
---
${transcript}
---

Return ONLY valid JSON in exactly this general shape:

{
  "legacyMarkdown": "## Persönliches\\n- ...",
  "memories": [
    {
      "action": "create",
      "type": "profile",
      "scope": "global",
      "content": "One self-contained durable fact.",
      "importance": 70,
      "confidence": 0.95,
      "expiresAt": null
    },
    {
      "action": "confirm",
      "id": 12
    },
    {
      "action": "archive",
      "id": 12
    },
    {
      "action": "replace",
      "id": 8,
      "type": "project",
      "scope": "project:echolink",
      "content": "The newer fact that replaces memory 8.",
      "importance": 80,
      "confidence": 0.95,
      "expiresAt": null
    }
  ]
}

Allowed memory types:
profile, preference, project, instruction, episodic, temporary, persona, fact

Allowed scopes:
global
project:<short-slug>
conversation:${conversationId}
persona:<short-slug>
temporary

Rules for structured memories:
- Return no more than 8 actions.
- Use "confirm" when an existing memory is still clearly supported.
- Use "archive" when the user explicitly asks to forget or remove an existing memory.
- Use "replace" only when the conversation clearly contradicts or updates an existing memory.
- Use "create" only for a genuinely new durable or meaningfully reusable fact.
- Compare every proposed memory by meaning with the existing memories.
- If the same fact already exists with different wording, use "confirm" with its existing ID.
- Do not create duplicates or paraphrased duplicates.
- Each content value must contain exactly one self-contained fact.
- Store explicit user statements, not guesses or model inferences.
- Skip greetings, temporary small talk and one-off details.
- Never store passwords, authentication tokens, API keys, banking data or private document contents.
- Do not store complete emails, attachments or chat transcripts.
- Temporary memories require expiresAt as an ISO date.
- Persona and roleplay memories must use persona:<slug> scope.
- Project-specific facts should use project:<slug>.
- Use the conversation language; default to German.

Rules for legacyMarkdown:
- Preserve still-valid existing facts.
- Remove facts clearly contradicted by newer information.
- Merge duplicates.
- Maximum 20 bullet points.
- One fact per bullet.
- Allowed headings:
  ## Persönliches
  ## Präferenzen
  ## Projekte & Ziele
  ## Arbeit & Fähigkeiten
  ## Aktueller Kontext
- Omit empty sections.
- Do not invent information.`

  const useModel = model || convo.model || DEFAULT_MODEL

  let generated

  try {
    generated = await runMemoryModel(useModel, extractPrompt)
  } catch (error) {
    console.error('Memory model failed:', error.message)
    return { ok: true, skipped: true, reason: 'model_failed' }
  }

  let parsed

  try {
    parsed = parseMemoryExtractionJson(generated)
  } catch (error) {
    console.error('Memory JSON parse failed:', error.message)
    return { ok: true, skipped: true, reason: 'invalid_json' }
  }

  const legacyCandidate = typeof parsed.legacyMarkdown === 'string'
    ? parsed.legacyMarkdown.trim()
    : ''

  const newMemory = legacyCandidate || existingMemory

  if (newMemory !== existingMemory) {
    db.prepare(`
      UPDATE users
      SET memory = ?
      WHERE id = ?
    `).run(newMemory.slice(0, 500000), userId)
  }

  const latestUserMessage = [...messages]
    .reverse()
    .find(message => message.role === 'user')

  const structured = applyStructuredMemories({
    userId,
    conversationId: Number(conversationId),
    sourceMessageId: latestUserMessage?.id || null,
    extractorModel: useModel,
    candidates: parsed.memories,
    activeItems
  })

  return {
    ok: true,
    memory: newMemory,
    structured
  }
}

// Update memory from a conversation (HTTP endpoint)
router.post('/update/:conversationId', requireAuth, async (req, res) => {
  const result = await extractMemory(req.session.userId, req.params.conversationId)
  res.json(result)
})

export default router
