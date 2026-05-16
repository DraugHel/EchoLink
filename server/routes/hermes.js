import { Router } from 'express'
import db from '../db.js'

const router = Router()
const HERMES_URL = process.env.HERMES_URL || 'http://localhost:8642'
const HERMES_KEY = process.env.HERMES_KEY || 'echolink-hermes-local'
const ALLOWED_USER_IDS = [1]  // Only draug

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  next()
}

const requireAgentAccess = (req, res, next) => {
  if (!ALLOWED_USER_IDS.includes(req.session.userId)) {
    return res.status(403).json({ error: 'Agent mode not available for this account' })
  }
  next()
}

// Check if user can use agent mode
router.get('/access', requireAuth, (req, res) => {
  res.json({ enabled: ALLOWED_USER_IDS.includes(req.session.userId) })
})

// Chat with hermes — streams response back
router.post('/:conversationId', requireAuth, requireAgentAccess, async (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.conversationId, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const { content } = req.body
  if (!content?.trim()) return res.status(400).json({ error: 'Empty message' })

  // Save user message
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(convo.id, 'user', content)

  // Build conversation history for hermes
  const history = db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(convo.id)

  const messages = []
  if (convo.system_prompt) messages.push({ role: 'system', content: convo.system_prompt })
  messages.push(...history.map(m => ({ role: m.role, content: m.content })))

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    const hermesRes = await fetch(`${HERMES_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HERMES_KEY}`
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages,
        stream: true
      })
    })

    if (!hermesRes.ok) {
      const err = await hermesRes.text()
      res.write(`data: ${JSON.stringify({ error: `Hermes ${hermesRes.status}: ${err.slice(0,200)}` })}\n\n`)
      return res.end()
    }

    let fullResponse = ''
    const reader = hermesRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue

        try {
          const json = JSON.parse(data)

          // Hermes custom tool progress event
          if (json.object === 'hermes.tool.progress' || json.event === 'hermes.tool.progress') {
            res.write(`data: ${JSON.stringify({ tool: json.tool || 'tool', status: 'running', query: json.input || json.arguments || '' })}\n\n`)
            continue
          }

          // Standard chat completion chunk
          const delta = json.choices?.[0]?.delta?.content
          if (delta) {
            fullResponse += delta
            res.write(`data: ${JSON.stringify({ token: delta })}\n\n`)
          }
        } catch {}
      }
    }

    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(convo.id, 'assistant', fullResponse)
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
  } catch (err) {
    console.error('Hermes error:', err)
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
  }

  res.end()
})

export default router
