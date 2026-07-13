import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db, { DEFAULT_MODEL } from '../db.js'

const router = Router()
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'

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

// Update memory from a conversation — called directly by chat.js or via HTTP
export async function extractMemory(userId, conversationId, model) {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(conversationId, userId)
  if (!convo) return { ok: true, skipped: true }

  // Get messages from this conversation
  const messages = db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
    LIMIT 40
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

  const useModel = model || convo.model || DEFAULT_MODEL
  const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: useModel,
      messages: [{ role: 'user', content: extractPrompt }],
      stream: false,
      options: { temperature: 0.3, top_p: 0.9 }
    })
  })

  if (!ollamaRes.ok) return { ok: true, skipped: true }

  const data = await ollamaRes.json()
  const newMemory = data.message?.content?.trim() || existingMemory

  db.prepare('UPDATE users SET memory = ? WHERE id = ?').run(newMemory, userId)
  return { ok: true, memory: newMemory }
}

// Update memory from a conversation (HTTP endpoint)
router.post('/update/:conversationId', requireAuth, async (req, res) => {
  const result = await extractMemory(req.session.userId, req.params.conversationId)
  res.json(result)
})

export default router
