import { Router } from 'express'
import db from '../db.js'
import crypto from 'crypto'

const router = Router()

const API_KEY = process.env.ECHO_API_KEY || process.env.EXTERNAL_API_KEY

// API Key auth — X-API-Key header or api_key query param
// Ohne konfigurierten Key wird alles abgelehnt (kein bekannter Default mehr)
const requireApiKey = (req, res, next) => {
  if (!API_KEY) {
    return res.status(503).json({ error: 'ECHO_API_KEY not configured on server' })
  }
  const key = req.headers['x-api-key'] || req.headers['x-external-api-key']
  const supplied = typeof key === 'string' ? Buffer.from(key) : null
  const expected = Buffer.from(API_KEY)

  if (
    !supplied ||
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
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

  const briefingConversationId = Number(process.env.BRIEFING_CONVERSATION_ID)
  const briefingUsername = process.env.BRIEFING_USERNAME?.trim()
  const briefingUserId = Number(process.env.BRIEFING_USER_ID)

  if (
    !Number.isSafeInteger(briefingConversationId) ||
    briefingConversationId <= 0
  ) {
    return res.status(503).json({
      error: 'BRIEFING_CONVERSATION_ID is not configured correctly'
    })
  }

  if (
    !briefingUsername &&
    (!Number.isSafeInteger(briefingUserId) || briefingUserId <= 0)
  ) {
    return res.status(503).json({
      error: 'Configure BRIEFING_USERNAME or BRIEFING_USER_ID'
    })
  }

  const user = briefingUsername
    ? db.prepare(
        'SELECT id, username FROM users WHERE username = ?'
      ).get(briefingUsername)
    : db.prepare(
        'SELECT id, username FROM users WHERE id = ?'
      ).get(briefingUserId)

  if (!user) {
    return res.status(404).json({
      error: 'Configured briefing user not found'
    })
  }

  const convo = db.prepare(`
    SELECT *
    FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(briefingConversationId, user.id)

  if (!convo) {
    return res.status(404).json({
      error: 'Configured briefing conversation not found for this user'
    })
  }

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