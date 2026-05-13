import { Router } from 'express'
import db from '../db.js'

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

  // Use user's default prompt + memory if none provided
  const GLOBAL_DEFAULT = process.env.DEFAULT_SYSTEM_PROMPT || ''
  const user = db.prepare('SELECT default_system_prompt, memory FROM users WHERE id = ?').get(req.session.userId)
  const defaultPrompt = user.default_system_prompt || GLOBAL_DEFAULT
  const memory = user.memory || ''

  // Build effective system prompt: base prompt + memory context
  let effectivePrompt = system_prompt !== undefined ? system_prompt : defaultPrompt
  if (memory && system_prompt === undefined) {
    effectivePrompt = effectivePrompt
      ? `${effectivePrompt}\n\n[What you know about the user from past conversations:\n${memory}]`
      : `[What you know about the user from past conversations:\n${memory}]`
  }

  const result = db.prepare(`
    INSERT INTO conversations (user_id, title, model, system_prompt, temperature, top_k, top_p)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.userId,
    title || 'New Conversation',
    model || 'llama3',
    effectivePrompt,
    temperature ?? 0.7,
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
  db.prepare('DELETE FROM conversations WHERE id = ?').run(convo.id)
  res.json({ ok: true })
})

// Get messages for a conversation
router.get('/:id/messages', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const messages = db.prepare(`
    SELECT id, role, content, created_at FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(convo.id)
  res.json(messages)
})

export default router
