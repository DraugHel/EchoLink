import { Router } from 'express'
import db from '../db.js'

const router = Router()
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  next()
}

// Get current memory
router.get('/', requireAuth, (req, res) => {
  const user = db.prepare('SELECT memory FROM users WHERE id = ?').get(req.session.userId)
  res.json({ memory: user.memory || '' })
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
    ORDER BY created_at ASC
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

  const extractPrompt = `You are a memory extraction system. Your job is to extract important, reusable facts about the user from a conversation.

${existingMemory ? `Existing memory about this user:\n${existingMemory}\n\n` : ''}New conversation to analyze:
---
${transcript}
---

Extract a concise, updated list of facts about the user. Rules:
- Only include stable facts (interests, projects, preferences, skills, context)
- Remove outdated facts if new info contradicts them
- Merge duplicates
- Max 20 bullet points
- Be specific, not vague ("works on EchoLink, a self-hosted LLM frontend" not "works on a project")
- Skip trivial small talk
- Format: one fact per line, starting with "- "
- If nothing new or useful, return the existing memory unchanged
- Return ONLY the bullet list, nothing else`

  const useModel = model || convo.model || 'llama3'
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
