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

// Update memory from a conversation — called directly by chat.js or via HTTP
export async function extractMemory(userId, conversationId, model) {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(conversationId, userId)
  if (!convo) return { ok: true, skipped: true }

  // Get messages from this conversation
  const messages = db.prepare(`
    SELECT role, content
    FROM (
      SELECT id, role, content
      FROM messages
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT 40
    ) AS recent_messages
    ORDER BY id ASC
  `).all(conversationId)

  if (messages.length < 2) return { ok: true, skipped: true }

  // Get existing memory
  const user = db.prepare('SELECT memory FROM users WHERE id = ?').get(userId)
  const existingMemory = user.memory || ''

  // Build prompt for memory extraction
  const transcript = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Echo'}: ${m.content.slice(0, 500)}`)
    .join('\n')

  const extractPrompt = `You are a memory extraction system. Your job is to maintain a concise, reusable profile of the user.

${existingMemory ? `Existing memory about this user:\n${existingMemory}\n\n` : ''}New conversation to analyze:
---
${transcript}
---

Create an updated memory in clear Markdown.

Use only the following section headings when relevant:
## Persönliches
## Präferenzen
## Projekte & Ziele
## Arbeit & Fähigkeiten
## Aktueller Kontext

Rules:
- Include only stable or meaningfully reusable facts
- Remove outdated facts when newer information contradicts them
- Merge duplicates and closely related facts
- Maximum 20 bullet points across all sections
- Write exactly one fact per bullet
- Be specific rather than vague
- Skip greetings, temporary small talk and one-off details
- Omit empty sections
- Do not invent information
- Preserve useful existing facts that are still valid
- Use the language of the existing memory or conversation; default to German
- If there are no new facts, reorganize the existing memory into this structure without changing its meaning
- Return only Markdown headings and bullet points, with no introduction or conclusion`

  const useModel =
    model ||
    convo.model ||
    DEFAULT_MODEL

  let generatedMemory = ''

  try {
    generatedMemory =
      await runMemoryModel(
        useModel,
        extractPrompt
      )
  } catch (error) {
    console.error(
      'Memory model failed:',
      error.message
    )

    return {
      ok: true,
      skipped: true,
      reason: 'model_failed'
    }
  }

  const newMemory =
    generatedMemory ||
    existingMemory

  db.prepare('UPDATE users SET memory = ? WHERE id = ?').run(newMemory, userId)
  return { ok: true, memory: newMemory }
}

// Update memory from a conversation (HTTP endpoint)
router.post('/update/:conversationId', requireAuth, async (req, res) => {
  const result = await extractMemory(req.session.userId, req.params.conversationId)
  res.json(result)
})

export default router
