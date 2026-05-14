import { Router } from 'express'
import db from '../db.js'
import { extractUrls, fetchAllUrls } from '../lib/fetchUrl.js'
import { UPLOAD_DIR, isImage, extractTextFromFile } from './uploads.js'
import { webSearch, SEARCH_TOOL } from '../lib/webSearch.js'
import fs from 'fs'
import path from 'path'

const router = Router()
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
const MAX_TOOL_ITERATIONS = 10

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  next()
}

async function executeTool(toolCall, res) {
  const name = toolCall.function?.name
  let args = toolCall.function?.arguments || {}
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch {}
  }

  if (name === 'web_search') {
    const query = args.query
    res.write(`data: ${JSON.stringify({ tool: 'web_search', status: 'running', query })}\n\n`)
    const result = await webSearch(query)
    res.write(`data: ${JSON.stringify({ tool: 'web_search', status: 'done', query, resultCount: result.results?.length || 0 })}\n\n`)

    if (result.error) return `Search error: ${result.error}`
    return result.results.map((r, i) =>
      `[${i+1}] ${r.title}\n${r.snippet}\nSource: ${r.source}`
    ).join('\n\n')
  }
  return `Unknown tool: ${name}`
}

async function chatNonStreaming(model, messages, options) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: false,
      tools: [SEARCH_TOOL],
      options
    })
  })
  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`Ollama ${r.status}: ${errBody.slice(0,200)}`)
  }
  return r.json()
}

router.post('/:conversationId', requireAuth, async (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.conversationId, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const { content, attachments, skipSave } = req.body
  if (!content?.trim() && (!attachments || attachments.length === 0)) {
    return res.status(400).json({ error: 'Empty message' })
  }

  // Detect URLs
  const urls = extractUrls(content)
  let urlContext = ''
  if (urls.length > 0) {
    const results = await fetchAllUrls(urls)
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

  // Save user message (skip on regenerate)
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : ''
  if (!skipSave) {
    db.prepare('INSERT INTO messages (conversation_id, role, content, images) VALUES (?, ?, ?, ?)')
      .run(convo.id, 'user', content || '', attachmentsJson)
  }

  // System prompt with memory
  const user = db.prepare('SELECT memory FROM users WHERE id = ?').get(req.session.userId)
  const memory = user?.memory || ''
  let systemContent = convo.system_prompt || ''
  if (memory) {
    systemContent = systemContent
      ? `${systemContent}\n\n[What you know about the user from past conversations:\n${memory}]`
      : `[What you know about the user from past conversations:\n${memory}]`
  }

  // History with attachments
  const history = db.prepare(`
    SELECT role, content, images FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(convo.id)

  const ollamaMessages = []
  if (systemContent) ollamaMessages.push({ role: 'system', content: systemContent })

  for (const m of history) {
    const msg = { role: m.role, content: m.content }
    if (m.images) {
      try {
        const items = JSON.parse(m.images)
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
        if (textParts.length > 0) msg.content = (msg.content ? msg.content + '\n\n' : '') + textParts.join('\n\n')
        if (base64Images.length > 0) msg.images = base64Images
      } catch (err) {
        console.error('Attachment processing failed:', err.message)
      }
    }
    ollamaMessages.push(msg)
  }

  if (urlContext && ollamaMessages.length > 0) {
    const last = ollamaMessages[ollamaMessages.length - 1]
    if (last.role === 'user') last.content = last.content + urlContext
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const options = {
    temperature: convo.temperature,
    top_k: convo.top_k,
    top_p: convo.top_p
  }

  try {
    let iterations = 0
    let workingMessages = [...ollamaMessages]

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++
      const response = await chatNonStreaming(convo.model, workingMessages, options)
      const message = response.message

      if (message.tool_calls && message.tool_calls.length > 0) {
        workingMessages.push({
          role: 'assistant',
          content: message.content || '',
          tool_calls: message.tool_calls
        })

        for (const tc of message.tool_calls) {
          const result = await executeTool(tc, res)
          workingMessages.push({
            role: 'tool',
            content: result
          })
        }
      } else {
        // Final response
        const thinking = message.thinking || ''
        const rawContent = message.content || ''
        const thinkTagMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/g)
        const thinkFromTags = thinkTagMatch
          ? thinkTagMatch.map(m => m.replace(/<\/?think>/g, '')).join('\n\n')
          : ''
        const cleanResponse = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        const allThinking = [thinking, thinkFromTags].filter(Boolean).join('\n\n')

        if (allThinking.trim()) {
          res.write(`data: ${JSON.stringify({ think: allThinking })}\n\n`)
        }

        const chunkSize = 20
        for (let i = 0; i < cleanResponse.length; i += chunkSize) {
          const t = cleanResponse.slice(i, i + chunkSize)
          res.write(`data: ${JSON.stringify({ token: t })}\n\n`)
        }

        db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
          .run(convo.id, 'assistant', cleanResponse)
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
        break
      }
    }

    if (iterations >= MAX_TOOL_ITERATIONS) {
      res.write(`data: ${JSON.stringify({ error: 'Max tool iterations reached' })}\n\n`)
    }
  } catch (err) {
    console.error('Chat error:', err)
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
  }

  res.end()
})

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
