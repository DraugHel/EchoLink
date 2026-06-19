import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import db from '../db.js'
import { extractTextFromFile, UPLOAD_DIR } from './uploads.js'

const router = Router()
const HERMES_URL = process.env.HERMES_URL || 'http://localhost:8642'
const HERMES_KEY = process.env.HERMES_KEY || 'echolink-hermes-local'
const SOUL_PATH = process.env.HERMES_SOUL_PATH || '/root/.hermes/SOUL.md'
// Aus .env (HERMES_ALLOWED_USER_IDS=1 oder 1,2), Fallback: nur User 1
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

// Check if user can use agent mode
router.get('/access', requireAuth, (req, res) => {
  res.json({ enabled: ALLOWED_USER_IDS.includes(req.session.userId) })
})

// Chat with hermes via /v1/runs — streams structured events back
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
  db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)

  // Build conversation history for hermes (all messages including the one we just saved)
  const history = db.prepare(`
    SELECT role, content, images FROM messages
    WHERE conversation_id = ? ORDER BY id ASC
  `).all(convo.id)

  // Build conversation_history (everything except the last user message)
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

  // Build the input (last user message — may include images as content array)
  const lastMsg = history[history.length - 1]
  let input = lastMsg.content || ''
  if (lastMsg.images) {
    try {
      const items = JSON.parse(lastMsg.images)
      const base64Images = []
      const textParts = []
      for (const it of items) {
        const isImg = typeof it === 'string' || it.kind === 'image'
        if (isImg) {
          const fn = typeof it === 'string' ? it : it.filename
          const filepath = path.join(UPLOAD_DIR, String(req.session.userId), fn)
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
        } else {
          try {
            const text = await extractTextFromFile(req.session.userId, it.filename, it.originalName)
            if (text) {
              const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n...[truncated]' : text
              textParts.push('--- File: ' + it.originalName + ' ---\n' + truncated)
            }
          } catch {}
        }
      }
      if (textParts.length > 0) input = (input ? input + '\n\n' : '') + textParts.join('\n\n')
      if (base64Images.length > 0) {
        input = [
          { type: 'text', text: typeof input === 'string' ? input : (lastMsg.content || '') },
          ...base64Images.map(b64 => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }))
        ]
      }
    } catch {}
  }

  // Build instructions (time + SOUL.md)
  const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short' })
  let instructions = 'Current time: ' + now + ' (CET)'
  try {
    const soulContent = fs.readFileSync(SOUL_PATH, 'utf-8')
    if (soulContent) instructions += '\n\n' + soulContent
  } catch {}

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  let saved = false
  let fullResponse = ''
  let approvalCount = 0

  try {
    // Start the run
    const runRes = await fetch(HERMES_URL + '/v1/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + HERMES_KEY
      },
      body: JSON.stringify({
        input: input,
        conversation_history: conversationHistory,
        instructions: instructions,
        model: 'hermes-agent'
      })
    })

    if (!runRes.ok) {
      const err = await runRes.text()
      res.write('data: ' + JSON.stringify({ error: 'Hermes ' + runRes.status + ': ' + err.slice(0, 200) }) + '\n\n')
      return res.end()
    }

    const runData = await runRes.json()
    const runId = runData.run_id

    // Connect to the events SSE stream
    const eventsRes = await fetch(HERMES_URL + '/v1/runs/' + runId + '/events', {
      headers: {
        'Authorization': 'Bearer ' + HERMES_KEY
      }
    })

    if (!eventsRes.ok) {
      const err = await eventsRes.text()
      res.write('data: ' + JSON.stringify({ error: 'Events ' + eventsRes.status + ': ' + err.slice(0, 200) }) + '\n\n')
      return res.end()
    }

    const reader = eventsRes.body.getReader()
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
          const evt = json.event
          console.log('[hermes] event:', evt, json.tool || json.delta ? '' : JSON.stringify(json).slice(0, 200))

          if (evt === 'message.delta') {
            if (json.delta) {
              fullResponse += json.delta
              res.write('data: ' + JSON.stringify({ token: json.delta }) + '\n\n')
            }
          } else if (evt === 'tool.started') {
            res.write('data: ' + JSON.stringify({ tool: json.tool, status: 'running', query: json.preview || '' }) + '\n\n')
          } else if (evt === 'tool.completed') {
            res.write('data: ' + JSON.stringify({ tool: json.tool, status: 'done', query: '' }) + '\n\n')
          // reasoning.available: skip — we don't send thinking blocks to the frontend
          } else if (evt === 'approval.request') {
            approvalCount++
            const actionId = runId + '_' + approvalCount
            console.log('[hermes] approval.request received:', JSON.stringify({ actionId, runId, description: json.description, command: json.command }))
            res.write('data: ' + JSON.stringify({
              actionRequest: true,
              actionId: actionId,
              runId: runId,
              description: json.description || 'Unknown action',
              command: json.command || '',
              type: 'shell'
            }) + '\n\n')
          } else if (evt === 'run.completed') {
            const output = fullResponse || json.output
            const usage = json.usage || {}
            const usageJson = JSON.stringify({
              prompt_tokens: usage.input_tokens || 0,
              completion_tokens: usage.output_tokens || 0,
              total_tokens: usage.total_tokens || 0
            })
            db.prepare('INSERT INTO messages (conversation_id, role, content, usage) VALUES (?, ?, ?, ?)')
              .run(convo.id, 'assistant', output, usageJson)
            db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)
            saved = true
            res.write('data: ' + JSON.stringify({
              done: true,
              usage: {
                prompt_tokens: usage.input_tokens || 0,
                completion_tokens: usage.output_tokens || 0,
                total_tokens: usage.total_tokens || 0
              }
            }) + '\n\n')
          } else if (evt === 'run.failed') {
            res.write('data: ' + JSON.stringify({ error: json.error || 'Run failed' }) + '\n\n')
          } else if (evt === 'run.cancelled') {
            if (!saved && fullResponse) {
              db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
                .run(convo.id, 'assistant', fullResponse)
              db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)
              saved = true
            }
            res.write('data: ' + JSON.stringify({ done: true }) + '\n\n')
          }
          // approval.responded events are silently ignored — the agent just continues
        } catch {}
      }
    }

    // Fallback: if stream ended without a terminal event, save what we have
    if (!saved && fullResponse) {
      db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .run(convo.id, 'assistant', fullResponse)
      db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)
    }
    // Ensure frontend stops the streaming indicator
    res.write('data: ' + JSON.stringify({ done: true }) + '\n\n')
  } catch (err) {
    console.error('Hermes error:', err)
    res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n')
  }

  res.end()
})

// Approve a pending action — proxies to Hermes /v1/runs/{runId}/approval
// actionId is {runId}_{approvalCount} — extract the runId part
router.post('/run/:actionId/approve', requireAuth, requireAgentAccess, async (req, res) => {
  try {
    const actionId = req.params.actionId
    const runId = actionId.includes('_') ? actionId.slice(0, actionId.lastIndexOf('_')) : actionId
    const hermesRes = await fetch(HERMES_URL + '/v1/runs/' + runId + '/approval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + HERMES_KEY
      },
      body: JSON.stringify({ choice: 'once' })
    })
    const data = await hermesRes.json()
    if (!hermesRes.ok) {
      return res.status(hermesRes.status).json(data)
    }
    res.json({ success: true, choice: data.choice })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Deny a pending action
router.post('/run/:actionId/deny', requireAuth, requireAgentAccess, async (req, res) => {
  try {
    const actionId = req.params.actionId
    const runId = actionId.includes('_') ? actionId.slice(0, actionId.lastIndexOf('_')) : actionId
    const hermesRes = await fetch(HERMES_URL + '/v1/runs/' + runId + '/approval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + HERMES_KEY
      },
      body: JSON.stringify({ choice: 'deny' })
    })
    const data = await hermesRes.json()
    if (!hermesRes.ok) {
      return res.status(hermesRes.status).json(data)
    }
    res.json({ success: true, denied: true, choice: data.choice })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router