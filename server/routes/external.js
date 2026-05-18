import { Router } from 'express'
import db from '../db.js'
import crypto from 'crypto'

const router = Router()

const API_KEY = process.env.ECHO_API_KEY || 'echolink-external-key'

// API Key auth — X-API-Key header or api_key query param
const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' })
  }
  next()
}

// POST /api/external/briefing
// Creates a new conversation and posts the briefing as an assistant message
// Body: { title, content, model? }
// Response: { conversation: {...}, message: {...} }
router.post('/briefing', requireApiKey, async (req, res) => {
  const { title, content } = req.body
  if (!content?.trim()) {
    return res.status(400).json({ error: 'Content is required' })
  }

  // Use user id 1 (draug) as the default user for external posts
  const userId = 1
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId)
  if (!user) {
    return res.status(404).json({ error: 'Default user not found' })
  }

  const model = req.body.model || process.env.DEFAULT_MODEL || 'glm-5.1:cloud'

  // Create conversation
  const convoResult = db.prepare(`
    INSERT INTO conversations (user_id, title, model, system_prompt, temperature, top_k, top_p)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    title || 'Morning Briefing',
    model,
    '',
    0.7,
    40,
    0.9
  )

  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convoResult.lastInsertRowid)

  // Insert briefing as assistant message
  const msgResult = db.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (?, ?, ?)
  `).run(convo.id, 'assistant', content.trim())

  const message = db.prepare('SELECT id, role, content, created_at FROM messages WHERE id = ?').get(msgResult.lastInsertRowid)

  res.json({ conversation: convo, message })
})

// GET /api/external/health — simple health check
router.get('/health', requireApiKey, (req, res) => {
  res.json({ status: 'ok' })
})

export default router