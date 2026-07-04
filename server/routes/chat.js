import { Router } from 'express'
import db from '../db.js'
import { extractUrls, fetchAllUrls } from '../lib/fetchUrl.js'
import { UPLOAD_DIR, isImage, extractTextFromFile } from './uploads.js'
import { webSearch, SEARCH_TOOL, firecrawlScrape, FIRECRAWL_TOOL, TERMINAL_TOOL } from '../lib/webSearch.js'
import { exec } from 'child_process'
import { resizeImageBuffer } from '../utils/image.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const router = Router()
const pendingTerminalActions = new Map()
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
const MAX_TOOL_ITERATIONS = 10

// --- Auto-Approve fuer harmlose read-only Commands ---
// Alles mit Shell-Metazeichen (Pipes, Chaining, Redirects, Substitution)
// braucht IMMER Approval — sonst laesst sich die Allowlist umgehen.
const UNSAFE_META = /[;&|><`$\n\\]/
const SAFE_PATTERNS = [
  /^(ls|pwd|whoami|date|uptime|uname|hostname|id)\b/,
  /^(cat|head|tail|wc|stat|file|du|df|free)\b/,
  /^(grep|find|which|ps|ss)\b/,
  /^pm2 (status|list|ls|info|show|describe)\b/,
  /^pm2 logs\b.*--nostream/,
  /^git (status|log|diff|show|branch|remote|stash list)\b/,
  /^(systemctl status|journalctl)\b/,
  /^docker (ps|logs|images)\b/,
  /^docker stats --no-stream\b/,
  /^node --check\b/,
]

function isSafeCommand(cmd) {
  const c = (cmd || '').trim()
  if (!c) return false
  // Inhalte in single quotes sind in der Shell literal -> vor dem Metazeichen-Check entfernen
  const stripped = c.replace(/'[^']*'/g, '')
  // Uebriggebliebene quote = unbalanciert -> lieber Approval
  if (stripped.includes("'")) return false
  if (UNSAFE_META.test(stripped)) return false
  // find kann ohne Metazeichen Commands ausfuehren -> -exec & Co. sperren
  if (/^find\b/.test(c) && /-(exec|execdir|delete|ok|okdir)\b/.test(c)) return false
  return SAFE_PATTERNS.some(re => re.test(c))
}

const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

// Command ausfuehren + Terminal-Message in DB (gleiche Bubble wie beim Approve-Flow)
function runCommand(command, conversationId) {
  return new Promise((resolve) => {
    exec(command, { timeout: 60000, cwd: '/root' }, (err, stdout, stderr) => {
      const output = stripAnsi((stdout || '').slice(0, 4000))
      const errOutput = stripAnsi((stderr || '').slice(0, 1000))
      const result = err
        ? `Exit code ${err.code}:\n${errOutput}${output}`
        : output || '(no output)'
      if (conversationId) {
        db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
          .run(conversationId, 'assistant', '**Terminal:** `' + command + '`\n```\n' + result + '\n```')
      }
      resolve(result)
    })
  })
}

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  next()
}

async function executeTool(toolCall, res, conversationId) {
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
  if (name === 'terminal') {
    const command = args.command
    const description = args.description || command
    // Harmlose read-only Commands laufen ohne Approval durch
    if (isSafeCommand(command)) {
      res.write(`data: ${JSON.stringify({ tool: 'terminal', status: 'running', query: command })}\n\n`)
      const result = await runCommand(command, conversationId)
      res.write(`data: ${JSON.stringify({ tool: 'terminal', status: 'done', query: command })}\n\n`)
      return result
    }
    // Pause and ask for approval
    return new Promise((resolve) => {
      const actionId = crypto.randomUUID()
      pendingTerminalActions.set(actionId, { command, conversationId, resolve })
      setTimeout(() => {
        if (pendingTerminalActions.has(actionId)) {
          pendingTerminalActions.delete(actionId)
          resolve('__TERMINAL_DONE__')
        }
      }, 5 * 60 * 1000)
      res.write(`data: ${JSON.stringify({
        actionRequest: true,
        actionId,
        description,
        command,
        type: 'shell',
        source: 'chat'
      })}\n\n`)
    })
  }
  if (name === 'firecrawl_scrape') {
    const url = args.url
    res.write(`data: ${JSON.stringify({ tool: 'firecrawl_scrape', status: 'running', query: url })}\n\n`)
    const result = await firecrawlScrape(url)
    res.write(`data: ${JSON.stringify({ tool: 'firecrawl_scrape', status: 'done', query: url })}\n\n`)
    if (result.error) return `Scrape error: ${result.error}`
    return `Content from ${url}:\n\n${result.content}`
  }
  return `Unknown tool: ${name}`
}

// Stream from Ollama, collecting tokens and forwarding to client
// abortSignal: AbortController signal to cancel the upstream Ollama fetch on client disconnect
async function streamOllama(model, messages, options, res, abortSignal) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: true,
      tools: [SEARCH_TOOL, FIRECRAWL_TOOL, TERMINAL_TOOL],
      options
    }),
    signal: abortSignal
  })
  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`Ollama ${r.status}: ${errBody.slice(0,200)}`)
  }

  let fullContent = ''
  let fullThinking = ''
  let toolCalls = null
  let tokenUsage = null

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const data = JSON.parse(line)

        // Check for Ollama error in stream
        if (data.error) throw new Error(data.error)

        if (data.done) {
          // Final event — may contain tool calls and token usage
          if (data.message?.tool_calls && data.message.tool_calls.length > 0) {
            toolCalls = data.message.tool_calls
          }
          // Extract token usage from Ollama
          if (data.total_duration) {
            tokenUsage = {
              promptTokens: data.prompt_eval_count || 0,
              completionTokens: data.eval_count || 0,
              totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
            }
          }
          continue
        }

        if (data.message?.tool_calls) {
          toolCalls = data.message.tool_calls
        }

        if (data.message?.content) {
          fullContent += data.message.content
          res.write(`data: ${JSON.stringify({ token: data.message.content })}\n\n`)
        }

        if (data.message?.thinking) {
          fullThinking += data.message.thinking
          res.write(`data: ${JSON.stringify({ think: data.message.thinking })}\n\n`)
        }

      } catch (e) {
        // Re-throw real errors (including data.error), but don't crash on JSON parse noise
        if (e.message && !e.message.includes('JSON')) throw e
      }
    }
  }

  return { fullContent, fullThinking, toolCalls, tokenUsage }
}

// Main chat endpoint

// Auto-update memory after response (direct function call instead of HTTP)
async function updateMemory(userId, conversationId, model) {
  const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND role = ?')
    .get(conversationId, 'assistant').count

  // Only update every ~10 assistant messages to avoid hammering
  if (msgCount % 10 !== 0) return

  try {
    const { extractMemory } = await import('./memory.js')
    await extractMemory(userId, conversationId, model)
  } catch {
    // Memory update failure is non-critical
  }
}

router.post('/:conversationId', requireAuth, async (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.conversationId, req.session.userId)
  if (!convo) return res.status(404).json({ error: 'Not found' })

  const { content, attachments, skipSave, regenerate } = req.body
  if (!content?.trim() && (!attachments || attachments.length === 0)) {
    return res.status(400).json({ error: 'Empty message' })
  }

  // Extract URLs from user message for auto-fetch
  let urlContext = ''
  if (content) {
    const urls = extractUrls(content)
    if (urls.length > 0) {
      try {
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
      } catch (e) {
        console.error('URL fetch failed:', e.message)
      }
    }
  }

  // Save user message (skip on regenerate)
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : ''
  if (!skipSave) {
    db.prepare('INSERT INTO messages (conversation_id, role, content, images) VALUES (?, ?, ?, ?)')
      .run(convo.id, 'user', content || '', attachmentsJson)
  }

  // Activity-Timestamp bumpen
  db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)

  // System prompt with memory
  const user = db.prepare('SELECT memory FROM users WHERE id = ?').get(req.session.userId)
  const memory = user?.memory || ''
  let systemContent = convo.system_prompt || ''
  // Standing rules aus RULES.md — immer injizieren, wird von der Memory-Extraktion nie angefasst
  try {
    const rulesText = fs.readFileSync('/root/echolink/RULES.md', 'utf-8').trim()
    if (rulesText) {
      systemContent = systemContent
        ? `${systemContent}\n\n[Standing rules from the user — always follow these:\n${rulesText}]`
        : `[Standing rules from the user — always follow these:\n${rulesText}]`
    }
  } catch {}
  if (memory) {
    systemContent = systemContent
      ? `${systemContent}\n\n[What you know about the user from past conversations:\n${memory}]`
      : `[What you know about the user from past conversations:\n${memory}]`
  }

  // History with attachments
  const history = db.prepare(`
    SELECT role, content, images FROM messages
    WHERE conversation_id = ?
      AND NOT (role = 'assistant' AND content LIKE '**Terminal:** %')
    ORDER BY id ASC
  `).all(convo.id)

  const ollamaMessages = []
  const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short' })
  const timeNote = `Current date and time: ${now} (CEST). Trust this — do not rely on your training data for the current date.`
  if (systemContent) {
    ollamaMessages.push({ role: 'system', content: systemContent + '\n\n' + timeNote })
  } else {
    ollamaMessages.push({ role: 'system', content: timeNote })
  }

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
              const resized = await resizeImageBuffer(fs.readFileSync(filepath), null, 1024)
              base64Images.push(resized.toString('base64'))
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

  // Auto-route to a vision-capable model if any message has an image attached
  const hasImages = ollamaMessages.some(m => m.images && m.images.length > 0)
  const VISION_MODEL = process.env.VISION_MODEL || 'kimi-k2.7-code:cloud'
  const activeModel = hasImages ? VISION_MODEL : convo.model

  if (urlContext && ollamaMessages.length > 0) {
    const last = ollamaMessages[ollamaMessages.length - 1]
    if (last.role === 'user') last.content = last.content + urlContext
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  // AbortController — kills the upstream Ollama fetch when the client disconnects
  const abortController = new AbortController()
  let clientDisconnected = false
  const onClose = () => {
    clientDisconnected = true
    abortController.abort()
  }
  req.on('close', onClose)

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

      const { fullContent, fullThinking, toolCalls, tokenUsage } = await streamOllama(activeModel, workingMessages, options, res, abortController.signal)

      // Handle tool calls
      if (toolCalls && toolCalls.length > 0) {
        workingMessages.push({
          role: 'assistant',
          content: fullContent || '',
          tool_calls: toolCalls
        })

        let terminalDone = false
        for (const tc of toolCalls) {
          const result = await executeTool(tc, res, convo.id)
          if (result === '__TERMINAL_DONE__') {
            terminalDone = true
          }
          workingMessages.push({
            role: 'tool',
            content: result === '__TERMINAL_DONE__' ? '(terminal output saved to chat)' : result
          })
        }
        if (terminalDone) {
          res.write('data: ' + JSON.stringify({ done: true }) + '\n\n')
          break
        }
        continue // Next iteration with tool results
      }

      // Final response — extract thinking from tags if native thinking is empty
      const THINK_TAG_RE = /<think>([\s\S]*?)<\/think>/g
      const thinkTagMatch = fullContent.match(THINK_TAG_RE)
      let cleanResponse = fullContent.replace(THINK_TAG_RE, '').trim()

      // Deduplicate: prefer native thinking, only fall back to tags
      let allThinking = fullThinking.trim()
      if (!allThinking && thinkTagMatch) {
        allThinking = thinkTagMatch.map(m => m.replace(/<\/?think>/g, '').trim()).filter(Boolean).join('\n\n')
      }

      // Only save to DB if client is still connected
      if (!clientDisconnected) {
        db.prepare('INSERT INTO messages (conversation_id, role, content, think, usage) VALUES (?, ?, ?, ?, ?)')
          .run(convo.id, 'assistant', cleanResponse, allThinking || '', tokenUsage ? JSON.stringify({
            prompt_tokens: tokenUsage.promptTokens,
            completion_tokens: tokenUsage.completionTokens,
            total_tokens: tokenUsage.totalTokens
          }) : '')
        db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(convo.id)

        res.write('data: ' + JSON.stringify({ done: true, ...(tokenUsage ? { tokens: tokenUsage } : {}) }) + '\n\n')

        // Auto-update memory periodically (non-blocking)
        updateMemory(req.session.userId, convo.id, convo.model).catch(err => console.error('Memory update failed:', err.message))
      }

      break
    }

    if (iterations >= MAX_TOOL_ITERATIONS) {
      res.write(`data: ${JSON.stringify({ error: 'Max tool iterations reached' })}\n\n`)
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Chat stream aborted by client disconnect')
    } else {
      console.error('Chat error:', err)
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
      }
    }
  }

  req.off('close', onClose)
  res.end()
})

// Approve a pending terminal action
router.post('/action/:actionId/approve', requireAuth, async (req, res) => {
  const entry = pendingTerminalActions.get(req.params.actionId)
  if (!entry) return res.status(404).json({ error: 'Action not found or expired' })
  pendingTerminalActions.delete(req.params.actionId)
  const { command, conversationId, resolve } = entry

  exec(command, { timeout: 60000, cwd: '/root' }, (err, stdout, stderr) => {
    const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    const output = stripAnsi((stdout || '').slice(0, 4000))
    const errOutput = stripAnsi((stderr || '').slice(0, 1000))
    const result = err
      ? `Exit code ${err.code}:\n${errOutput}${output}`
      : output || '(no output)'

    // Write result directly to DB as assistant message
    if (conversationId) {
      db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .run(conversationId, 'assistant', '**Terminal:** `' + command + '`\n```\n' + result + '\n```')
    }

    resolve(result)
  })

  res.json({ success: true })
})

// Deny a pending terminal action
router.post('/action/:actionId/deny', requireAuth, (req, res) => {
  const entry = pendingTerminalActions.get(req.params.actionId)
  if (!entry) return res.status(404).json({ error: 'Action not found or expired' })
  pendingTerminalActions.delete(req.params.actionId)
  const { resolve } = entry
  resolve('Terminal action denied by user')
})


// Get pending terminal actions for a conversation
router.get('/:conversationId/actions', requireAuth, (req, res) => {
  res.json([...pendingTerminalActions.entries()]
    .filter(([id, entry]) => entry.conversationId === req.params.conversationId)
    .map(([id, entry]) => ({
      actionId: id,
      description: entry.command,
      command: entry.command,
      type: 'shell',
      source: 'chat'
    }))
  )
})

// Update memory endpoint
router.post('/memory', requireAuth, async (req, res) => {
  const { content } = req.body
  db.prepare('UPDATE users SET memory = ? WHERE id = ?').run(content || '', req.session.userId)
  res.json({ success: true })
})

// Get memory
router.get('/memory', requireAuth, (req, res) => {
  const user = db.prepare('SELECT memory FROM users WHERE id = ?').get(req.session.userId)
  const memory = user?.memory || ''
  res.json({ memory })
})

// Get token usage stats
router.get('/stats', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT
    SUM(CASE WHEN json_extract(usage, '$.total_tokens') IS NOT NULL THEN json_extract(usage, '$.total_tokens') ELSE 0 END) as total_tokens,
    SUM(CASE WHEN json_extract(usage, '$.completion_tokens') IS NOT NULL THEN json_extract(usage, '$.completion_tokens') ELSE 0 END) as completion_tokens,
    SUM(CASE WHEN json_extract(usage, '$.prompt_tokens') IS NOT NULL THEN json_extract(usage, '$.prompt_tokens') ELSE 0 END) as prompt_tokens
  FROM messages WHERE usage IS NOT NULL AND usage != ''`).get()
  res.json(row || {})
})

export default router
