import { Router } from 'express'
import bcrypt from 'bcryptjs'
import db from '../db.js'

const router = Router()

const GLOBAL_DEFAULT = process.env.DEFAULT_SYSTEM_PROMPT || ''

router.post('/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' })

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user) return res.status(401).json({ error: 'Invalid credentials' })

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

  req.session.userId = user.id
  req.session.username = user.username
  res.json({ username: user.username })
})

router.post('/logout', (req, res) => {
  req.session.destroy()
  res.json({ ok: true })
})

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  const user = db.prepare('SELECT username, default_system_prompt FROM users WHERE id = ?').get(req.session.userId)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })
  res.json({
    username: user.username,
    defaultSystemPrompt: user.default_system_prompt || GLOBAL_DEFAULT
  })
})

// Get effective default prompt (user > global)
router.get('/default-prompt', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  const user = db.prepare('SELECT default_system_prompt FROM users WHERE id = ?').get(req.session.userId)
  res.json({ prompt: user.default_system_prompt || GLOBAL_DEFAULT })
})

// Update user's default prompt
router.patch('/default-prompt', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  const { prompt } = req.body
  db.prepare('UPDATE users SET default_system_prompt = ? WHERE id = ?').run(prompt ?? '', req.session.userId)
  res.json({ ok: true, prompt: prompt ?? '' })
})

export default router
