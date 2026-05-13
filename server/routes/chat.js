import { Router } from 'express'
import db from '../db.js'
import { extractUrls, fetchAllUrls } from '../lib/fetchUrl.js'
import { UPLOAD_DIR, isImage, extractTextFromFile } from './uploads.js'
import fs from 'fs'
import path from 'path'

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

  const { content, attachments } = req.body
  console.log('[chat] received attachments:', JSON.stringify(attachments))
  if (!content?.trim() && (!attachments || attachments.length === 0)) {
    return res.status(400).json({ error: 'Empty message' })
  }

  // Detect and fetch URLs from user message
  const urls = extractUrls(content)
  console.log('[chat] extracted URLs:', urls)
  let urlContext = ''
  if (urls.length > 0) {
    const results = await fetchAllUrls(urls)
    console.log('[chat] fetch results:', results.map(r => ({ url: r.url, error: r.error, contentLen: r.content?.length })))
    const successful = results.filter(r => !r.error)
    if (successful.length > 0) {
      urlContext = '\n\n[Content from URLs in user message:\n' +
        successful.map(r =>
          `--- ${r.url} ---\n` +
          (r.title ? `Title: ${r.title}\n\n` : '') +
          r.content +
          (r.truncated ? '\n...[truncated]' : '')
        ).join('\n\n') +
        '\n]'
    }
  }

  // Save original user message with attachments
  // attachments is array of { filename, originalName, size, kind }
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : ''
  db.prepare('INSERT INTO messages (conversation_id, role, content, images) VALUES (?, ?, ?, ?)')
    .run(convo.id, 'user', content || '', attachmentsJson)

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
    SELECT role, content, images FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(convo.id)

  const ollamaMessages = []
  if (convo.system_prompt) {
    ollamaMessages.push({ role: 'system', content: convo.system_prompt })
  }

  for (const m of history) {
    const msg = { role: m.role, content: m.content }
    if (m.images) {
      try {
        const items = JSON.parse(m.images)
        // items: array of either old-format strings (filenames) or new-format objects
        const normalized = items.map(it => typeof it === 'string'
          ? { filename: it, originalName: it, kind: 'image' }
          : it)

        const base64Images = []
        const textParts = []

        for (const att of normalized) {
          if (att.kind === 'image') {
            const filepath = path.join(UPLOAD_DIR, String(req.session.userId), att.filename)
            if (fs.existsSync(filepath)) {
              base64Images.push(fs.readFileSync(filepath).toString('base64'))
            }
          } else {
            const text = await extractTextFromFile(req.session.userId, att.filename, att.originalName)
            if (text) {
              const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n...[truncated]' : text
              textParts.push(`--- File: ${att.originalName} ---\n${truncated}`)
            }
          }
        }

        if (textParts.length > 0) {
          msg.content = (msg.content ? msg.content + '\n\n' : '') + textParts.join('\n\n')
        }
        if (base64Images.length > 0) msg.images = base64Images
      } catch (err) {
        console.error('Attachment processing failed:', err.message)
      }
    }
    ollamaMessages.push(msg)
  }

  // Append URL context to the last user message (only for this request, not stored)
  if (urlContext && ollamaMessages.length > 0) {
    const last = ollamaMessages[ollamaMessages.length - 1]
    if (last.role === 'user') {
      last.content = last.content + urlContext
    }
  }

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

    // Track <think> tag state — send think content separately
    let inThink = false
    let buffer = ''
    let fullThink = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter(Boolean)

      for (const line of lines) {
        try {
          const json = JSON.parse(line)
          if (json.message?.content) {
            buffer += json.message.content

            // Process buffer
            while (true) {
              if (inThink) {
                const end = buffer.indexOf('</think>')
                if (end !== -1) {
                  const thinkChunk = buffer.slice(0, end)
                  fullThink += thinkChunk
                  if (thinkChunk) res.write(`data: ${JSON.stringify({ think: thinkChunk })}\n\n`)
                  inThink = false
                  buffer = buffer.slice(end + 8)
                } else {
                  // Still in think — send what we have (minus tail in case tag is split)
                  if (buffer.length > 8) {
                    const safe = buffer.slice(0, -8)
                    fullThink += safe
                    res.write(`data: ${JSON.stringify({ think: safe })}\n\n`)
                    buffer = buffer.slice(-8)
                  }
                  break
                }
              } else {
                const start = buffer.indexOf('<think>')
                if (start !== -1) {
                  // Send text before think tag
                  const before = buffer.slice(0, start)
                  if (before) {
                    fullResponse += before
                    res.write(`data: ${JSON.stringify({ token: before })}\n\n`)
                  }
                  inThink = true
                  buffer = buffer.slice(start + 7)
                } else {
                  // No think tag — safe to send minus last 7 chars
                  if (buffer.length > 7) {
                    const safe = buffer.slice(0, -7)
                    fullResponse += safe
                    res.write(`data: ${JSON.stringify({ token: safe })}\n\n`)
                    buffer = buffer.slice(-7)
                  }
                  break
                }
              }
            }
          }
          if (json.done) {
            // Flush remaining buffer
            if (buffer && !inThink) {
              fullResponse += buffer
              if (buffer.trim()) res.write(`data: ${JSON.stringify({ token: buffer })}\n\n`)
            }
            // Save clean response (no think tags)
            db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
              .run(convo.id, 'assistant', fullResponse.trim())
            res.write(`data: ${JSON.stringify({ done: true, hasThink: !!fullThink })}\n\n`)
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
