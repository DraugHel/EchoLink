import { Router } from 'express'
import bcrypt from 'bcryptjs'
import db from '../db.js'

const router = Router()

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
  res.json({ username: req.session.username, id: req.session.userId })
})

export default router
