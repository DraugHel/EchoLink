import { Router } from 'express'
import fs from 'fs'
import { exec } from 'child_process'
import { randomUUID } from 'crypto'
import db from '../db.js'

const router = Router()
const HERMES_URL = process.env.HERMES_URL || 'http://localhost:8642'
const HERMES_KEY = process.env.HERMES_KEY || 'echolink-hermes-local'
const ALLOWED_USER_IDS = [1]  // Only draug

// Pending actions awaiting user approval
const pendingActions = new Map()

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

  const { content, attachments } = req.body
  if (!content?.trim() && (!attachments || attachments.length === 0)) return res.status(400).json({ error: 'Empty message' })

  // Save user message
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : ''
  db.prepare('INSERT INTO messages (conversation_id, role, content, images) VALUES (?, ?, ?, ?)')
    .run(convo.id, 'user', content || '', attachmentsJson)

  // Build conversation history for hermes
  const history = db.prepare(`
    SELECT role, content, images FROM messages
    WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(convo.id)

  const messages = []
  for (const m of history) {
    const msg = { role: m.role, content: m.content || '' }
    if (m.images) {
      try {
        const items = JSON.parse(m.images)
        const base64Images = []
        for (const it of items) {
          const isImg = typeof it === 'string' || it.kind === 'image'
          if (isImg) {
            const fn = typeof it === 'string' ? it : it.filename
            const filepath = `/root/echolink/data/uploads/${req.session.userId}/${fn}`
            if (fs.existsSync(filepath)) {
              try {
                const sharp = (await import('sharp')).default
                const resized = await sharp(filepath)
                  .resize({ width: 512, withoutEnlargement: true })
                  .jpeg({ quality: 60 })
                  .toBuffer()
                base64Images.push(resized.toString('base64'))
              } catch {
                base64Images.push(fs.readFileSync(filepath).toString('base64'))
              }
            }
          }
        }
        if (base64Images.length > 0) {
          msg.content = [
            { type: 'text', text: m.content || '' },
            ...base64Images.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))
          ]
        }
      } catch {}
    }
    messages.push(msg)
  }

  // Inject SOUL.md after chat history as a reminder
  try {
    const soulContent = fs.readFileSync('/root/.hermes/SOUL.md', 'utf-8')
      if (soulContent) messages.push({ role: 'system', content: soulContent })
  } catch {}

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    const hermesRes = await fetch(HERMES_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + HERMES_KEY
      },
      body: JSON.stringify({
        model: convo.model || 'hermes-agent',
        messages,
        stream: true
      })
    })

    if (!hermesRes.ok) {
      const err = await hermesRes.text()
      res.write('data: ' + JSON.stringify({ error: 'Hermes ' + hermesRes.status + ': ' + err.slice(0,200) }) + '\n\n')
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
            const toolName = json.tool || 'tool'
            res.write('data: ' + JSON.stringify({ tool: toolName, status: 'running', query: json.input || json.arguments || '' }) + '\n\n')
            continue
          }

          // Hermes tool result/completion event
          if (json.object === 'hermes.tool.result' || json.event === 'hermes.tool.result') {
            const toolName = json.tool || 'tool'
            res.write('data: ' + JSON.stringify({ tool: toolName, status: 'done', result: json.result || '' }) + '\n\n')
            continue
          }

          // Hermes action request — needs user approval
          if (json.object === 'hermes.action.request' || json.event === 'hermes.action.request') {
            const actionId = randomUUID()
            const action = {
              conversationId: convo.id,
              type: json.type || 'shell',
              command: json.command || '',
              description: json.description || json.command || 'Unknown action',
              createdAt: Date.now()
            }
            pendingActions.set(actionId, action)
            // Expire after 10 minutes
            setTimeout(() => pendingActions.delete(actionId), 10 * 60 * 1000)
            res.write('data: ' + JSON.stringify({
              actionRequest: true,
              actionId,
              description: action.description,
              command: action.command,
              type: action.type
            }) + '\n\n')
            continue
          }

          // Token usage in final chunk
          if (json.usage) {
            res.write('data: ' + JSON.stringify({ usage: json.usage }) + '\n\n')
          }

          // Standard chat completion chunk
          const delta = json.choices?.[0]?.delta?.content
          if (delta) {
            fullResponse += delta
            res.write('data: ' + JSON.stringify({ token: delta }) + '\n\n')
          }
        } catch {}
      }
    }

    console.log('[hermes] saving response, length:', fullResponse.length)
    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(convo.id, 'assistant', fullResponse)
    res.write('data: ' + JSON.stringify({ done: true }) + '\n\n')
    console.log('[hermes] done sent')
  } catch (err) {
    console.error('Hermes error:', err)
    res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n')
  }

  res.end()
})

// Approve a pending action
router.post('/action/:actionId/approve', requireAuth, requireAgentAccess, async (req, res) => {
  const action = pendingActions.get(req.params.actionId)
  if (!action) return res.status(404).json({ error: 'Action not found or expired' })
  if (action.conversationId !== req.body.conversationId) return res.status(403).json({ error: 'Action does not belong to this conversation' })

  pendingActions.delete(req.params.actionId)

  const { type, command, conversationId } = action

  if (type === 'shell' && command) {
    exec(command, { timeout: 30000, cwd: '/root/echolink' }, (err, stdout, stderr) => {
      const output = (stdout || '').slice(0, 2000)
      const errOutput = (stderr || '').slice(0, 500)
      const result = err
        ? 'Exit code ' + err.code + '. ' + errOutput + output
        : output || '(no output)'

      // Save result as assistant message
      db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .run(conversationId, 'assistant', '**Action approved:** `' + command + '`\n```\n' + result + '\n```')

      res.json({ success: true, result })
    })
  } else {
    res.json({ success: true, message: 'Action approved (no command to run)' })
  }
})

// Deny a pending action
router.post('/action/:actionId/deny', requireAuth, requireAgentAccess, (req, res) => {
  const action = pendingActions.get(req.params.actionId)
  if (!action) return res.status(404).json({ error: 'Action not found or expired' })

  pendingActions.delete(req.params.actionId)

  // Save denial as assistant message
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(action.conversationId, 'assistant', '**Action denied:** ' + action.description)

  res.json({ success: true, denied: true })
})

// List pending actions for a conversation
router.get('/actions/:conversationId', requireAuth, requireAgentAccess, (req, res) => {
  const actions = []
  for (const [id, action] of pendingActions) {
    if (action.conversationId === req.params.conversationId) {
      actions.push({ actionId: id, ...action })
    }
  }
  res.json(actions)
})

export default router