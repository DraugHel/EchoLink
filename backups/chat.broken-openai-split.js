import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db from '../db.js'
import { extractUrls, fetchAllUrls } from '../lib/fetchUrl.js'
import { UPLOAD_DIR, extractTextFromFile } from './uploads.js'
import { webSearch, SEARCH_TOOL, firecrawlScrape, FIRECRAWL_TOOL, TERMINAL_TOOL } from '../lib/webSearch.js'
import { OLLAMA_URL, streamOllama } from '../providers/ollama.js'
import { streamOpenAI, streamZai, splitSystemTimeNote } from '../providers/openai-compatible.js'
import { exec } from 'child_process'
import { resizeImageBuffer } from '../utils/image.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const router = Router()
const pendingTerminalActions = new Map()
const MAX_TOOL_ITERATIONS = 25

// --- Auto-Approve fuer harmlose read-only Commands ---
// Alles mit Shell-Metazeichen (Pipes, Chaining, Redirects, Substitution)
// braucht IMMER Approval — sonst laesst sich die Allowlist umgehen.
const UNSAFE_META = /[;&|><`$\n\\]/
const SAFE_PATTERNS = [
  /^(ls|pwd|whoami|date|uptime|uname|hostname|id|echo|stat)\b/,
  /^(cat|head|tail|wc|stat|file|du|df|free)\b/,
  /^(grep|find|which|ps|ss)\b/,
  /^pm2 (status|list|ls|info|show|describe)\b/,
  /^pm2 logs\b.*--nostream/,
  /^git (status|log|diff|show|branch|remote|stash list)\b/,
  /^(systemctl status|journalctl)\b/,
  /^docker (ps|logs|images)\b/,
  /^docker stats --no-stream\b/,
  /^(sort|uniq|cut|tr|column|jq|nl|tac)\b/,
  /^(md5sum|sha256sum|sha1sum|cksum|b2sum)\b/,
  /^node --check\b/,
]

// --- Skills (progressive disclosure): Index immer, Volltext per cat oder /trigger ---
const SKILLS_DIR = '/root/echolink/skills'

function skillsIndex() {
  try {
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory())
    const entries = []
    for (const d of dirs) {
      try {
        const md = fs.readFileSync(path.join(SKILLS_DIR, d.name, 'SKILL.md'), 'utf-8')
        const m = md.match(/^description:\s*(.+)$/m) || md.match(/\|\s*description\s*\|\s*([\s\S]+?)\s*\|/)
        const desc = m ? m[1].replace(/\s+/g, ' ').slice(0, 220) : ''
        entries.push(`- ${d.name}: ${desc}`)
      } catch { /* Ordner ohne SKILL.md ueberspringen */ }
    }
    return entries
  } catch { return [] }
}

function skillFullText(name) {
  if (!/^[\w-]+$/.test(name)) return null
  try { return fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8') } catch { return null }
}

const ALLOWLIST_PATH = new URL('../../data/auto-approve.json', import.meta.url).pathname

function userAllowedPrefixes() {
  try { return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf-8')) } catch { return [] }
}

// Warum braucht ein Command Approval? (fuer die UI)
function approvalReason(cmd) {
  const c = (cmd || '').trim()
  const masked = c.replace(/'[^']*'/g, 'Q')
  if (masked.includes("'")) return 'Unbalancierte Quotes'
  if (/[;&><`$\n\\]/.test(masked)) return 'Shell-Metazeichen ausserhalb von Quotes'
  if (SENSITIVE_PATH.test(c)) return 'Zugriff auf sensible Datei (.env/Keys/DB) — Approval erforderlich'
  if (masked.includes('|')) return 'Pipe-Segment nicht auf der Auto-Approve-Liste'
  return 'Nicht auf der Auto-Approve-Liste'
}

function segIsSafe(seg) {
  const s = seg.trim()
  if (!s) return false
  // find kann ohne Metazeichen Commands ausfuehren -> -exec & Co. sperren
  if (/^find\b/.test(s) && /-(exec|execdir|delete|ok|okdir)\b/.test(s)) return false
  if (SAFE_PATTERNS.some(re => re.test(s))) return true
  return userAllowedPrefixes().some(p => typeof p === 'string' && p.length >= 3 && !NEVER_ALLOW.test(p) && s.startsWith(p))
}

const SENSITIVE_PATH = /(^|[\s'"/=])(\.env|\.git-credentials|id_rsa|id_ed25519|\.pem|\.key|credentials|secrets?|\.aws|\.ssh|shadow|\.hermes|\.openclaw|auto-approve\.json|echolink\.db|\.npmrc)/i

function redactSecrets(text) {
  if (!text) return text
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-***REDACTED***')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***REDACTED***')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***REDACTED***')
    .replace(/[0-9a-f]{32}\.[A-Za-z0-9]{16}/g, '***REDACTED-KEY***')
    .replace(/(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)(\s*[=:]\s*)\S+/gi, '$1$2***REDACTED***')
}

function looksLikeExfil(url) {
  if (!url || typeof url !== 'string') return true
  if (SENSITIVE_PATH.test(url)) return true
  if (/sk-[A-Za-z0-9_-]{16,}|[0-9a-f]{32}\.[A-Za-z0-9]{16}|ghp_[A-Za-z0-9]{20,}/.test(url)) return true
  try {
    const u = new URL(url)
    for (const [, v] of u.searchParams) if (v.length > 120) return true
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|localhost$|\[?::1)/i.test(u.hostname)) return true
  } catch { return true }
  return false
}

function isSafeCommand(cmd) {
  const c = (cmd || '').trim()
  if (!c) return false
  // Single-quote-Inhalte sind in der Shell literal -> maskieren, dann pruefen
  let masked = c.replace(/'[^']*'/g, 'Q')
  // Uebriggebliebene quote = unbalanciert -> lieber Approval
  if (masked.includes("'")) return false
  // &&-, ||- und ;-Chaining wie Pipes behandeln: als Segment-Trenner normalisieren
  masked = masked.replace(/&&|\|\||;/g, '|')
  // Restliche Metazeichen bleiben hart gesperrt (einzelnes & = Backgrounding)
  if (/[&><`$\n\\]/.test(masked)) return false
  // Zugriff auf sensible Pfade -> nie auto-approven (Anti-Exfiltration)
  if (SENSITIVE_PATH.test(c)) return false
  // Ok, wenn JEDES Segment mit einem freigegebenen Command beginnt
  return masked.split('|').every(segIsSafe)
}

const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

// Command ausfuehren + Terminal-Message in DB (gleiche Bubble wie beim Approve-Flow)
function runCommand(command, conversationId) {
  return new Promise((resolve) => {
    exec(command, { timeout: 60000, cwd: '/root' }, (err, stdout, stderr) => {
      const output = stripAnsi((stdout || '').slice(0, 4000))
      const errOutput = stripAnsi((stderr || '').slice(0, 1000))
      const result = redactSecrets(err
        ? `Exit code ${err.code}:\n${errOutput}${output}`
        : output || '(no output)')
      if (conversationId) {
        db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
          .run(conversationId, 'assistant', '**Terminal:** `' + command + '`\n```\n' + result + '\n```')
      }
      resolve(result)
    })
  })
}

const CHAT_LIMITS = {
  content: 200_000,
  memory: 500_000,
  attachments: 5,
  attachmentName: 255
}

function validateAttachments(attachments) {
  if (attachments === undefined || attachments === null) return null

  if (!Array.isArray(attachments)) {
    return 'attachments muss ein Array sein'
  }

  if (attachments.length > CHAT_LIMITS.attachments) {
    return `Maximal ${CHAT_LIMITS.attachments} Anhaenge pro Nachricht`
  }

  for (const item of attachments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return 'Ungueltiger Attachment-Eintrag'
    }

    if (
      typeof item.filename !== 'string' ||
      !item.filename ||
      item.filename.length > CHAT_LIMITS.attachmentName
    ) {
      return 'Ungueltiger Attachment-Dateiname'
    }

    // Nur serverseitig generierte, einfache Dateinamen akzeptieren.
    if (
      item.filename.includes('/') ||
      item.filename.includes('\\') ||
      item.filename.includes('..') ||
      item.filename.includes('\0')
    ) {
      return 'Ungueltiger Attachment-Pfad'
    }

    if (
      item.originalName !== undefined &&
      (
        typeof item.originalName !== 'string' ||
        item.originalName.length > CHAT_LIMITS.attachmentName
      )
    ) {
      return 'Ungueltiger Original-Dateiname'
    }
  }

  return null
}

function validateChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Ungueltiger Request-Body'
  }

  if (body.content !== undefined && typeof body.content !== 'string') {
    return 'content muss ein String sein'
  }

  if ((body.content || '').length > CHAT_LIMITS.content) {
    return `Nachricht ist zu lang (maximal ${CHAT_LIMITS.content} Zeichen)`
  }

  if (body.skipSave !== undefined && typeof body.skipSave !== 'boolean') {
    return 'skipSave muss true oder false sein'
  }

  if (body.regenerate !== undefined && typeof body.regenerate !== 'boolean') {
    return 'regenerate muss true oder false sein'
  }

  return validateAttachments(body.attachments)
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
        reason: approvalReason(command),
        type: 'shell',
        source: 'chat'
      })}\n\n`)
    })
  }
  if (name === 'firecrawl_scrape') {
    const url = args.url
    if (looksLikeExfil(url)) return 'Blocked: URL enthaelt verdaechtige Parameter (moegliche Datenexfiltration).'
    res.write(`data: ${JSON.stringify({ tool: 'firecrawl_scrape', status: 'running', query: url })}\n\n`)
    const result = await firecrawlScrape(url)
    res.write(`data: ${JSON.stringify({ tool: 'firecrawl_scrape', status: 'done', query: url })}\n\n`)
    if (result.error) return `Scrape error: ${result.error}`
    return `Content from ${url}:\n\n${result.content}`
  }
  return `Unknown tool: ${name}`
}


// ===================== Anthropic API Provider =====================
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''

function anthropicTools() {
  return [SEARCH_TOOL, FIRECRAWL_TOOL, TERMINAL_TOOL].map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }))
}

function imgMediaType(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBOR')) return 'image/png'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

// Ollama-internes Message-Format -> Anthropic Messages API Format
function toAnthropic(messages) {
  let system = ''
  const out = []
  let pendingToolIds = []
  for (const m of messages) {
    if (m.role === 'system') { system += (system ? '\n\n' : '') + m.content; continue }
    if (m.role === 'assistant' && m._raw) {
      pendingToolIds = m._raw.filter(b => b.type === 'tool_use').map(b => b.id)
      // Invariante: _raw ist read-only geteilter Zustand (Signaturen muessen byte-identisch
      // ueber alle Iterationen bleiben). Kopie an der Grenze — Mutationen wie cache_control
      // treffen dann nur die Kopie dieses Requests, nie die naechste Iteration.
      out.push({ role: 'assistant', content: m._raw.map(b => ({ ...b })) })
      continue
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      pendingToolIds = []
      m.tool_calls.forEach((tc, i) => {
        const id = tc.id || `toolu_gen_${out.length}_${i}`
        pendingToolIds.push(id)
        blocks.push({ type: 'tool_use', id, name: tc.function.name, input: tc.function.arguments || {} })
      })
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.role === 'tool') {
      const id = pendingToolIds.shift() || `toolu_gen_${out.length}`
      const block = { type: 'tool_result', tool_use_id: id, content: String(m.content ?? '') }
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (m.images?.length) {
      const blocks = m.images.map(b64 => ({
        type: 'image', source: { type: 'base64', media_type: imgMediaType(b64), data: b64 }
      }))
      if (m.content) blocks.push({ type: 'text', text: m.content })
      out.push({ role: m.role, content: blocks })
    } else {
      out.push({ role: m.role, content: m.content || '' })
    }
  }
  return { system, messages: out }
}

// Gleiches Interface wie streamOllama: { fullContent, fullThinking, toolCalls, tokenUsage }
async function streamAnthropic(model, messages, options, res, abortSignal) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY fehlt in der .env')
  const { system, messages: msgs } = toAnthropic(messages)

  // --- Prompt Caching ---
  // Alte Cache-Marker abraeumen: _raw-Bloecke werden per Referenz wiederverwendet,
  // sonst akkumulieren Breakpoints ueber die Tool-Iterationen (API-Limit: 4)
  for (const m of msgs) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) { if (b && b.cache_control) delete b.cache_control }
    }
  }
  // Die timeNote (aendert sich minuetlich) wuerde den Cache-Praefix jedes Mal
  // invalidieren -> raus aus dem System-Prompt, rein in die letzte User-Message
  // (die ist ohnehin nie Teil eines Cache-Hits).
  let stableSystem = system
  let timeNote = ''
  {
    const lines = stableSystem.split('\n')
    const kept = []
    for (const ln of lines) {
      if (ln.startsWith('Current date and time:')) timeNote = ln
      else kept.push(ln)
    }
    stableSystem = kept.join('\n').trim()
  }
  if (timeNote) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        if (typeof msgs[i].content === 'string') {
          msgs[i].content += `\n\n[${timeNote}]`
        } else if (Array.isArray(msgs[i].content)) {
          msgs[i].content.push({ type: 'text', text: `[${timeNote}]` })
        }
        break
      }
    }
  }
  // Breakpoint 1: stabiler System-Prompt (cached auch die Tools davor mit)
  const systemParam = stableSystem
    ? [{ type: 'text', text: stableSystem, cache_control: { type: 'ephemeral' } }]
    : undefined
  // Breakpoint 2: vorletzte Message -> History-Praefix waechst inkrementell mit
  if (msgs.length >= 2) {
    const m = msgs[msgs.length - 2]
    if (typeof m.content === 'string' && m.content) {
      m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
    } else if (Array.isArray(m.content) && m.content.length) {
      // Breakpoint nie auf Thinking-Bloecke setzen
      for (let j = m.content.length - 1; j >= 0; j--) {
        if (m.content[j].type !== 'thinking' && m.content[j].type !== 'redacted_thinking') {
          m.content[j].cache_control = { type: 'ephemeral' }
          break
        }
      }
    }
  }
  // --- Ende Prompt Caching ---

  const RE = options?.reasoningEffort || ''
  const thinkingOn = RE !== '' && RE !== 'off'
  const body = {
    model, max_tokens: 16384, stream: true,
    messages: msgs,
    tools: anthropicTools(),
    ...(systemParam ? { system: systemParam } : {}),
    // Thinking an: adaptive + effort; temperature ist dann nicht erlaubt
    ...(thinkingOn
      ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: RE } }
      : (options?.temperature != null ? { temperature: Math.min(options.temperature, 1) } : {}))
  }
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: abortSignal
  })
  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`Anthropic ${r.status}: ${errBody.slice(0, 200)}`)
  }

  let fullContent = '', fullThinking = ''
  const toolBlocks = {}
  const rawBlocks = {}  // alle Content-Bloecke in Reihenfolge — muessen bei Tool-Use verbatim zurueck
  let inputTokens = 0, outputTokens = 0
  let buf = ''
  const decoder = new TextDecoder()

  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let ev
      try { ev = JSON.parse(line.slice(6)) } catch { continue }
      if (ev.type === 'error') throw new Error(ev.error?.message || 'Anthropic stream error')
      if (ev.type === 'message_start') {
        const u = ev.message?.usage || {}
        // Cache-Tokens mitzaehlen, damit die Anzeige die echte Kontextgroesse zeigt
        inputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      }
      if (ev.type === 'content_block_start' && ev.content_block) {
        const cb = ev.content_block
        if (cb.type === 'tool_use') {
          toolBlocks[ev.index] = { id: cb.id, name: cb.name, json: '' }
          rawBlocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} }
        } else if (cb.type === 'thinking') {
          rawBlocks[ev.index] = { type: 'thinking', thinking: '', signature: '' }
        } else if (cb.type === 'redacted_thinking') {
          rawBlocks[ev.index] = { type: 'redacted_thinking', data: cb.data }
        } else if (cb.type === 'text') {
          rawBlocks[ev.index] = { type: 'text', text: '' }
        }
      }
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') {
          fullContent += ev.delta.text
          if (rawBlocks[ev.index]) rawBlocks[ev.index].text += ev.delta.text
          res.write(`data: ${JSON.stringify({ token: ev.delta.text })}\n\n`)
        } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
          fullThinking += ev.delta.thinking
          if (rawBlocks[ev.index]) rawBlocks[ev.index].thinking += ev.delta.thinking
          res.write(`data: ${JSON.stringify({ think: ev.delta.thinking })}\n\n`)
        } else if (ev.delta?.type === 'signature_delta' && rawBlocks[ev.index]) {
          rawBlocks[ev.index].signature = (rawBlocks[ev.index].signature || '') + ev.delta.signature
        } else if (ev.delta?.type === 'input_json_delta' && toolBlocks[ev.index]) {
          toolBlocks[ev.index].json += ev.delta.partial_json
        }
      }
      if (ev.type === 'message_delta' && ev.usage?.output_tokens != null) {
        outputTokens = ev.usage.output_tokens
      }
    }
  }

  const toolCalls = Object.values(toolBlocks).map(t => {
    let args = {}
    try { args = t.json ? JSON.parse(t.json) : {} } catch {}
    return { id: t.id, function: { name: t.name, arguments: args } }
  })
  // tool_use-Inputs in den rohen Bloecken finalisieren
  for (const [idx, tb] of Object.entries(toolBlocks)) {
    if (rawBlocks[idx]) {
      try { rawBlocks[idx].input = tb.json ? JSON.parse(tb.json) : {} } catch {}
    }
  }
  const rawOutput = Object.keys(rawBlocks).length
    ? Object.keys(rawBlocks).sort((a, b) => a - b).map(k => rawBlocks[k])
    : null
  const tokenUsage = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens
  }
  return { fullContent, fullThinking, toolCalls, t_effort: 'none' })
// ===================== Ende OpenAI-kompatible Provider =====================

// ===================== OpenAI Responses API (Reasoning + Tools) =====================
const RESPONSES_URL = 'https://api.openai.com/v1/responses'

// Internes Format -> Responses-API-Input. Assistant-Messages mit _raw
// (Items aus vorheriger Responses-Iteration, inkl. Reasoning) gehen verbatim zurueck —
// nur so bleibt die Denkkette ueber Tool-Calls hinweg erhalten.
function toResponsesInput(messages) {
  let instructions = ''
  const input = []
  let pendingCallIds = []
  for (const m of messages) {
    if (m.role === 'system') { instructions += (instructions ? '\n\n' : '') + m.content; continue }
    if (m.role === 'assistant' && m._raw) {
      pendingCallIds = m._raw.filter(it => it.type === 'function_call').map(it => it.call_id)
      // Invariante: _raw ist read-only — Kopie an der Grenze (siehe toAnthropic)
      input.push(...m._raw.map(it => ({ ...it })))
      continue
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      if (m.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      pendingCallIds = []
      m.tool_calls.forEach((tc, i) => {
        const id = tc.id || `call_gen_${input.length}_${i}`
        pendingCallIds.push(id)
        input.push({ type: 'function_call', call_id: id, name: tc.function.name, arguments: JSON.stringify(tc.function.arguments || {}) })
      })
      continue
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: pendingCallIds.shift() || `call_gen_${input.length}`, output: String(m.content ?? '') })
      continue
    }
    if (m.images?.length) {
      const parts = m.images.map(b64 => ({ type: 'input_image', image_url: `data:${imgMediaType(b64)};base64,${b64}` }))
      if (m.content) parts.push({ type: 'input_text', text: m.content })
      input.push({ role: 'user', content: parts })
    } else if (m.role === 'assistant') {
      input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content || '' }] })
    } else {
      input.push({ role: 'user', content: [{ type: 'input_text', text: m.content || '' }] })
    }
  }
  return { instructions, input }
}

async function streamResponses(model, messages, options, res, abortSignal) {
  if (!OPENAI_KEY) throw new Error('API-Key fuer OpenAI fehlt in der .env')
  const { instructions, input } = toResponsesInput(messages)
  const body = {
    model, stream: true, store: false,
    include: ['reasoning.encrypted_content'],
    input,
    ...(instructions ? { instructions } : {}),
    tools: [SEARCH_TOOL, FIRECRAWL_TOOL, TERMINAL_TOOL].map(t => ({
      type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters
    })),
    // chat-latest-Varianten sind Instant-Modelle und lehnen den reasoning-Param ab
    ...(model.includes('chat') ? {} : { reasoning: {
      summary: 'detailed',
      ...(options?.reasoningEffort
        ? { effort: options.reasoningEffort === 'off' ? 'none' : options.reasoningEffort }
        : {})
    } })
    // Reasoning-Modelle lehnen temperature/top_p ab -> bewusst weggelassen
  }
  const r = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(body),
    signal: abortSignal
  })
  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`OpenAI Responses ${r.status}: ${errBody.slice(0, 200)}`)
  }

  let fullContent = '', fullThinking = ''
  let rawOutput = null, usage = null
  let buf = ''
  const decoder = new TextDecoder()

  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let ev
      try { ev = JSON.parse(payload) } catch { continue }
      if (ev.type === 'response.output_text.delta' && ev.delta) {
        fullContent += ev.delta
        res.write(`data: ${JSON.stringify({ token: ev.delta })}\n\n`)
      } else if (ev.type === 'response.reasoning_summary_text.delta' && ev.delta) {
        fullThinking += ev.delta
        res.write(`data: ${JSON.stringify({ think: ev.delta })}\n\n`)
      } else if (ev.type === 'response.completed') {
        rawOutput = ev.response?.output || null
        usage = ev.response?.usage || null
      } else if (ev.type === 'response.failed' || ev.type === 'error') {
        throw new Error(ev.response?.error?.message || ev.message || 'OpenAI Responses stream error')
      }
    }
  }

  const toolCalls = (rawOutput || []).filter(it => it.type === 'function_call').map(it => {
    let args = {}
    try { args = it.arguments ? JSON.parse(it.arguments) : {} } catch {}
    return { id: it.call_id, function: { name: it.name, arguments: args } }
  })
  const tokenUsage = usage ? {
    promptTokens: usage.input_tokens || 0,
    completionTokens: usage.output_tokens || 0,
    totalTokens: usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0))
  } : null
  return { fullContent, fullThinking, toolCalls, tokenUsage, rawOutput }
}
// ===================== Ende Responses API =====================



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
  const validationError = validateChatBody(req.body)
  if (validationError) {
    return res.status(400).json({ error: validationError })
  }

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

  // Skills: kompakter Index immer; bei /<skill-name> in der Nachricht der Volltext
  {
    const idx = skillsIndex()
    if (idx.length) {
      let skillsNote = `[Available skills (folders under ${SKILLS_DIR}):\n${idx.join('\n')}\nWhen a task matches a skill or the user types /<skill-name>, FIRST read ${SKILLS_DIR}/<name>/SKILL.md with the terminal tool (cat is auto-approved), then follow it literally. Files under its references/ are loaded the same way, only when actually needed.]`
      const trigger = (content || '').match(/(?:^|\s)\/([\w-]+)/)
      if (trigger) {
        const full = skillFullText(trigger[1])
        if (full) {
          skillsNote = `[The user invoked the skill "${trigger[1]}" — follow it literally. Its references/ files can be read with the terminal tool (cat) when needed:\n\n${full.slice(0, 12000)}]`
          console.log(`[skills] injected full text: ${trigger[1]}`)
        }
      }
      systemContent = systemContent ? `${systemContent}\n\n${skillsNote}` : skillsNote
    }
  }
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
    top_p: convo.top_p,
    reasoningEffort: convo.reasoning_effort || ''
  }

  let allContent = ''
  let accThinking = ''
  try {
    let iterations = 0
    let workingMessages = [...ollamaMessages]

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++

      let streamFn = streamOllama
      let providerModel = activeModel
      if (activeModel.startsWith('claude')) streamFn = streamAnthropic
      else if (activeModel.startsWith('zai/')) { streamFn = streamZai; providerModel = activeModel.slice(4) }
      else if (activeModel.startsWith('openai/')) { streamFn = streamResponses; providerModel = activeModel.slice(7) }
      if (streamFn === streamOpenAI || streamFn === streamZai || streamFn === streamResponses) {
        workingMessages = splitSystemTimeNote(workingMessages)
      }
      const { fullContent, fullThinking, toolCalls, tokenUsage, rawOutput } = await streamFn(providerModel, workingMessages, options, res, abortController.signal)
      if (fullContent) allContent += (allContent ? '\n\n' : '') + fullContent
      if (fullThinking) accThinking += (accThinking ? '\n\n' : '') + fullThinking

      // Handle tool calls
      if (toolCalls && toolCalls.length > 0) {
        workingMessages.push({
          role: 'assistant',
          content: fullContent || '',
          tool_calls: toolCalls,
          // Responses-API: Items (inkl. Reasoning) fuer die naechste Iteration mitnehmen
          ...(rawOutput ? { _raw: rawOutput } : {})
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
      const thinkTagMatch = allContent.match(THINK_TAG_RE)
      let cleanResponse = allContent.replace(THINK_TAG_RE, '').trim()

      // Deduplicate: prefer native thinking, only fall back to tags
      let allThinking = accThinking.trim()
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
      const partial = allContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      if (!clientDisconnected && partial) {
        db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
          .run(convo.id, 'assistant', partial + '\n\n*[abgebrochen: Tool-Limit erreicht]*')
        res.write('data: ' + JSON.stringify({ done: true }) + '\n\n')
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Chat stream aborted by client disconnect')
    } else {
      console.error('Chat error:', err)
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
        const partial = allContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        if (partial) {
          db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
            .run(convo.id, 'assistant', partial + '\n\n*[abgebrochen: ' + err.message.slice(0, 120) + ']*')
        }
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
  const { content } = req.body || {}

  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content muss ein String sein' })
  }

  if (content.length > CHAT_LIMITS.memory) {
    return res.status(400).json({
      error: `Memory ist zu lang (maximal ${CHAT_LIMITS.memory} Zeichen)`
    })
  }

  db.prepare('UPDATE users SET memory = ? WHERE id = ?').run(content, req.session.userId)
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

// List available models from Ollama
router.get('/models/list', requireAuth, async (req, res) => {
  const models = []
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`)
    const data = await r.json()
    models.push(...(data.models || []))
  } catch { /* Ollama nicht erreichbar */ }
  if (ANTHROPIC_KEY) {
    try {
      const r2 = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
      })
      const d2 = await r2.json()
      models.push(...(d2.data || []).map(m => ({ name: m.id, provider: 'anthropic' })))
    } catch { /* Anthropic nicht erreichbar */ }
  }
  if (ZAI_KEY) {
    models.push(
      { name: 'zai/glm-5.2', provider: 'zai' },
      { name: 'zai/glm-5.1', provider: 'zai' },
      { name: 'zai/glm-4.7', provider: 'zai' }
    )
  }
  if (OPENAI_KEY) {
    try {
      const r3 = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}` }
      })
      const d3 = await r3.json()
      models.push(...(d3.data || [])
        .map(m => m.id)
        .filter(id => /^(gpt-5|gpt-4|o[0-9])/.test(id) && !/audio|realtime|image|transcribe|tts|search|embedding/.test(id))
        .sort().reverse()
        .map(id => ({ name: 'openai/' + id, provider: 'openai' })))
    } catch { /* OpenAI nicht erreichbar */ }
  }
  if (models.length === 0) return res.status(503).json({ error: 'Could not reach any model provider' })
  res.json(models)
})

// "Immer erlauben": Command-Prefix in die User-Allowlist aufnehmen
// Destruktive Commands duerfen NIE auf die Auto-Approve-Liste — egal was der User klickt
const NEVER_ALLOW = /^(rm|rmdir|mv|dd|mkfs|shred|shutdown|reboot|halt|poweroff|kill|killall|pkill|chmod|chown|truncate|userdel|groupdel|fdisk|parted|wipefs|iptables|ufw|bash|sh|zsh|python3?|perl|ruby|node|npx|curl|wget)\b|^(pm2 (delete|kill|flush))|^(git (push|reset|checkout|clean|rebase))|^(docker (rm|rmi|kill|prune|system|exec|run|compose))|^(npm (uninstall|remove))\b/

router.post('/allowlist', requireAuth, (req, res) => {
  const prefix = (req.body?.prefix || '').trim()
  if (prefix.length < 3 || prefix.length > 80) return res.status(400).json({ error: 'Prefix 3-80 Zeichen' })
  if (/[;&|><`$\n\\'"]/.test(prefix)) return res.status(400).json({ error: 'Keine Metazeichen im Prefix' })
  if (NEVER_ALLOW.test(prefix)) return res.status(400).json({ error: 'Destruktive Commands koennen nicht dauerhaft freigegeben werden' })
  const list = userAllowedPrefixes()
  if (!list.includes(prefix)) {
    list.push(prefix)
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2))
  }
  res.json({ ok: true, prefixes: list })
})

export default router
