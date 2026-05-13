import { Router } from 'express'
import db from '../db.js'

const router = Router()
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  next()
}

router.post('/:conversationId', requireAuth, async (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.conversationId, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const { content } = req.body
  if (!content?.trim()) return res.status(400).json({ error: 'Empty message' })

  // Save user message
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(convo.id, 'user', content)

  // Auto-title from first message
  const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(convo.id).c
  if (msgCount === 1 && convo.title === 'New Conversation') {
    const title = content.slice(0, 50).trim()
    db.prepare('UPDATE conversations SET title = ?, updated_at = unixepoch() WHERE id = ?').run(title, convo.id)
  } else {
    db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)
  }

  // Build message history for Ollama
  const history = db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(convo.id)

  const ollamaMessages = []
  if (convo.system_prompt) {
    ollamaMessages.push({ role: 'system', content: convo.system_prompt })
  }
  ollamaMessages.push(...history.map(m => ({ role: m.role, content: m.content })))

  // Stream from Ollama
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  let fullResponse = ''

  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: convo.model,
        messages: ollamaMessages,
        stream: true,
        options: {
          temperature: convo.temperature,
          top_k: convo.top_k,
          top_p: convo.top_p
        }
      })
    })

    if (!ollamaRes.ok) {
      const errBody = await ollamaRes.text()
      console.error('Ollama error:', ollamaRes.status, errBody)
      res.write(`data: ${JSON.stringify({ error: `Ollama error ${ollamaRes.status}: ${errBody.slice(0,200)}` })}\n\n`)
      res.end()
      return
    }

    const reader = ollamaRes.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter(Boolean)

      for (const line of lines) {
        try {
          const json = JSON.parse(line)
          if (json.message?.content) {
            fullResponse += json.message.content
            res.write(`data: ${JSON.stringify({ token: json.message.content })}\n\n`)
          }
          if (json.done) {
            // Save assistant message
            db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
              .run(convo.id, 'assistant', fullResponse)
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
          }
        } catch {}
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
  }

  res.end()
})

// Get available models from Ollama
router.get('/models/list', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`)
    const data = await r.json()
    res.json(data.models || [])
  } catch {
    res.status(503).json({ error: 'Could not reach Ollama' })
  }
})

export default router
