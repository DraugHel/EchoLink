import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import db from '../db.js'
import { extractTextFromFile } from './uploads.js'

const router = Router()
const HERMES_URL = process.env.HERMES_URL || 'http://localhost:8642'
const HERMES_KEY = process.env.HERMES_KEY || 'echolink-hermes-local'
const SOUL_PATH = process.env.HERMES_SOUL_PATH || '/root/.hermes/SOUL.md'
const ALLOWED_USER_IDS = (process.env.HERMES_ALLOWED_USER_IDS || '1')
  .split(',').map(s => Number(s.trim())).filter(Number.isFinite)

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

router.get('/access', requireAuth, (req, res) => {
  res.json({ enabled: ALLOWED_USER_IDS.includes(req.session.userId) })
})

router.post('/:conversationId', requireAuth, requireAgentAccess, async (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.conversationId, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const { content, attachments, skipSave } = req.body
  if (!content?.trim() && (!attachments || attachments.length === 0)) return res.status(400).json({ error: 'Empty message' })

  if (!skipSave) {
    const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : ''
    db.prepare('INSERT INTO messages (conversation_id, role, content, images) VALUES (?, ?, ?, ?)')
      .run(convo.id, 'user', content || '', attachmentsJson)
    db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)
  }

  const history = db.prepare(`
    SELECT role, content, images FROM messages
    WHERE conversation_id = ? ORDER BY id ASC
  `).all(convo.id)

  const conversationHistory = []
  for (let i = 0; i < history.length - 1; i++) {
    const m = history[i]
    let textContent = m.content || ''
    if (m.images) {
      try {
        const items = JSON.parse(m.images)
        const textParts = []
        for (const it of items) {
          if (typeof it !== 'string' && it.kind !== 'image') {
            try {
              const text = await extractTextFromFile(req.session.userId, it.filename, it.originalName)
              if (text) {
                const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n...[truncated]' : text
                textParts.push('--- File: ' + it.originalName + ' ---\n' + truncated)
              }
            } catch {}
          }
        }
        if (textParts.length > 0) textContent = (textContent ? textContent + '\n\n' : '') + textParts.join('\n\n')
      } catch {}
    }
    conversationHistory.push({ role: m.role, content: textContent })
  }

  const lastMsg = history[history.length - 1]
  let input = lastMsg.content || ''
  if (lastMsg.images) {
    try {
      const items = JSON.parse(lastMsg.images)
      const textParts = []
      for (const it of items) {
        const isImg = typeof it === 'string' || it.kind === 'image'
        if (!isImg) {
          const text = await extractTextFromFile(req.session.userId, it.filename, it.originalName)
          if (text) {
            const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n...[truncated]' : text
            textParts.push('--- File: ' + it.originalName + ' ---\n' + truncated)
          }
        }
      }
      if (textParts.length > 0) input = (input ? input + '\n\n' : '') + textParts.join('\n\n')
    } catch {}
  }

  // Load SOUL.md
  let soul = ''
  try {
    soul = fs.readFileSync(SOUL_PATH, 'utf8')
  } catch {}

  // Build request to hermes /v1/runs
  const runPayload = {
    input,
    conversation_history: conversationHistory,
    conversation_id: convo.id,
    model: convo.model,
    system_prompt: soul,
    stream: true
  }

  const response = await fetch(`${HERMES_URL}/v1/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HERMES_KEY}`
    },
    body: JSON.stringify(runPayload)
  })

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`Hermes ${response.status}: ${errBody.slice(0, 200)}`)
  }

  // Track client disconnect
  let clientDisconnected = false
  const onClose = () => { clientDisconnected = true }
  req.on('close', onClose)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''
  let fullThinking = ''
  let toolCalls = null

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  while (!clientDisconnected) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const json = JSON.parse(line)
        const evt = json.event || json.type || 'unknown'
        // Only log non-delta events to avoid PM2 log spam
        if (evt !== 'message.delta' && evt !== 'thinking.delta') {
          console.log('[hermes] event:', evt, json.tool ? '' : JSON.stringify(json).slice(0, 200))
        }
        if (json.event === 'message.delta' || json.type === 'message.delta') {
          if (json.delta) {
            fullContent += json.delta
            res.write(`data: ${JSON.stringify({ delta: json.delta })}\n\n`)
          }
        } else if (json.event === 'thinking.delta' || json.type === 'thinking.delta') {
          if (json.delta) {
            fullThinking += json.delta
            res.write(`data: ${JSON.stringify({ thinking: json.delta })}\n\n`)
          }
        } else if (json.event === 'tool.call' || json.type === 'tool.call') {
          toolCalls = toolCalls || []
          toolCalls.push(json)
        } else if (json.event === 'approval.request' || json.type === 'approval.request') {
          const { actionId, runId, description, command } = json
          console.log('[hermes] approval.request received:', JSON.stringify({ actionId, runId, description: json.description, command: json.command }))
          res.write(`data: ${JSON.stringify({
            actionRequest: true,
            actionId,
            description,
            command,
            type: 'shell',
            source: 'hermes'
          })}\n\n`)
        } else if (json.event === 'run.completed' || json.type === 'run.completed') {
          break
        }
      } catch {}
    }
  }

  req.off('close', onClose)

  if (clientDisconnected) return

  // Save assistant message
  db.prepare('INSERT INTO messages (conversation_id, role, content, think) VALUES (?, ?, ?, ?)')
    .run(convo.id, 'assistant', fullContent, fullThinking || '')
  db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)

  res.write('data: ' + JSON.stringify({ done: true }) + '\n\n')
  res.end()
})

// Approve terminal action from hermes
router.post('/action/:actionId/approve', requireAuth, requireAgentAccess, async (req, res) => {
  const { runId } = req.body
  const response = await fetch(`${HERMES_URL}/v1/runs/${runId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HERMES_KEY}`
    }
  })
  res.json({ success: response.ok })
})

// Deny terminal action from hermes
router.post('/action/:actionId/deny', requireAuth, requireAgentAccess, async (req, res) => {
  const { runId } = req.body
  const response = await fetch(`${HERMES_URL}/v1/runs/${runId}/deny`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HERMES_KEY}`
    }
  })
  res.json({ success: response.ok })
})

export default router
