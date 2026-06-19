import { Router } from 'express'
import db, { DEFAULT_MODEL } from '../db.js'
import { deleteFilesForConvo, deleteFilesForMessage } from './uploads.js'

const router = Router()

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  next()
}

// Get all conversations for current user
router.get('/', requireAuth, (req, res) => {
  const convos = db.prepare(`
    SELECT id, title, model, system_prompt, temperature, top_k, top_p, created_at, updated_at
    FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(req.session.userId)
  res.json(convos)
})

// Create new conversation
router.post('/', requireAuth, (req, res) => {
  const { title, model, system_prompt, temperature, top_k, top_p } = req.body

  // Use user's default prompt if none provided
  // Memory is no longer baked into system_prompt — it's appended at chat time
  const GLOBAL_DEFAULT = process.env.DEFAULT_SYSTEM_PROMPT || ''
  const user = db.prepare('SELECT default_system_prompt FROM users WHERE id = ?').get(req.session.userId)
  const defaultPrompt = user.default_system_prompt || GLOBAL_DEFAULT

  const effectivePrompt = system_prompt !== undefined ? system_prompt : defaultPrompt

  const result = db.prepare(`
    INSERT INTO conversations (user_id, title, model, system_prompt, temperature, top_k, top_p)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.userId,
    title || 'New Conversation',
    model || DEFAULT_MODEL,
    effectivePrompt,
    temperature ?? 0.5,
    top_k ?? 40,
    top_p ?? 0.9
  )
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid)
  res.json(convo)
})

// Update conversation
router.patch('/:id', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const { title, model, system_prompt, temperature, top_k, top_p } = req.body
  db.prepare(`
    UPDATE conversations
    SET title = ?, model = ?, system_prompt = ?, temperature = ?, top_k = ?, top_p = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(
    title ?? convo.title,
    model ?? convo.model,
    system_prompt ?? convo.system_prompt,
    temperature ?? convo.temperature,
    top_k ?? convo.top_k,
    top_p ?? convo.top_p,
    convo.id
  )
  res.json(db.prepare('SELECT * FROM conversations WHERE id = ?').get(convo.id))
})

// Delete conversation
router.delete('/:id', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })
  // Clean up images before deleting messages (cascade)
  deleteFilesForConvo(req.session.userId, convo.id)
  db.prepare('DELETE FROM conversations WHERE id = ?').run(convo.id)
  res.json({ ok: true })
})

// Get messages for a conversation
router.get('/:id/messages', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const messages = db.prepare(`
    SELECT id, role, content, images, usage, created_at FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
  `).all(convo.id)
  // Parse usage JSON for each message
  for (const m of messages) {
    m.usage = m.usage ? JSON.parse(m.usage) : null
  }
  res.json(messages)
})

// Delete last assistant message (for regenerate)
router.delete('/:id/last-assistant', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const last = db.prepare(`
    SELECT id, images FROM messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY id DESC LIMIT 1
  `).get(convo.id)

  if (last) {
    // Clean up any files attached to this message
    deleteFilesForMessage(req.session.userId, last.images)
    db.prepare('DELETE FROM messages WHERE id = ?').run(last.id)
  }
  res.json({ ok: true })
})

router.delete('/message/:messageId', requireAuth, (req, res) => {
  const msg = db.prepare(`
    SELECT messages.id, messages.images FROM messages
    JOIN conversations ON conversations.id = messages.conversation_id
    WHERE messages.id = ? AND conversations.user_id = ?
  `).get(req.params.messageId, req.session.userId)
  if (!msg) return res.status(404).json({ error: 'Not found' })
  // Anhaenge der Message direkt mit aufraeumen (nicht auf den 6h-Cleanup warten)
  deleteFilesForMessage(req.session.userId, msg.images)
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.messageId)
  res.json({ success: true })
})

export default router
