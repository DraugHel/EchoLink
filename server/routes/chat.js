import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db from '../db.js'
import {
  formatMemoryItemsForPrompt,
  selectMemoryItemsForContext
} from '../lib/memoryItems.js'
import { extractUrls, fetchAllUrls } from '../lib/fetchUrl.js'
import { UPLOAD_DIR, extractTextFromFile } from './uploads.js'
import { webSearch, firecrawlScrape } from '../lib/webSearch.js'
import {
  executeTaskTool,
  TASK_TOOL_NAMES
} from '../lib/taskTools.js'
import {
  CALENDAR_TOOL_NAMES,
  executeCalendarTool,
  formatCalendarCreatePreview,
  prepareCalendarCreateEvent
} from '../lib/calendarTools.js'
import {
  CALENDAR_EXTRA_TOOL_NAMES,
  CALENDAR_EXTRA_WRITE_NAMES,
  calendarExtraActionLabel,
  executeCalendarExtraTool,
  formatCalendarExtraPreview,
  prepareCalendarExtraAction
} from '../lib/calendarExtraTools.js'
import {
  GMAIL_TOOL_NAMES,
  GMAIL_WRITE_TOOL_NAMES,
  executeGmailTool,
  formatGmailDeleteDraftPreview,
  formatGmailSendDraftPreview,
  prepareGmailDeleteDraft,
  prepareGmailSendDraft
} from '../lib/gmailTools.js'
import { OLLAMA_URL, streamOllama } from '../providers/ollama.js'
import { OPENAI_KEY, ZAI_KEY, streamZai, splitSystemTimeNote } from '../providers/openai-compatible.js'
import { ANTHROPIC_KEY, streamAnthropic } from '../providers/anthropic.js'
import { streamResponses } from '../providers/openai-responses.js'
import { exec } from 'child_process'
import { resizeImageBuffer } from '../utils/image.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const router = Router()
const pendingTerminalActions = new Map()
const pendingCalendarActions = new Map()
const pendingGmailActions = new Map()

function gmailActionCard(
  toolName,
  action
) {
  if (toolName === 'gmail_delete_draft') {
    return {
      description:
        'Gmail-Entwurf löschen',
      reason:
        'Der Entwurf wird erst nach deiner Bestätigung endgültig gelöscht.',
      command:
        formatGmailDeleteDraftPreview(action)
    }
  }

  return {
    description:
      'Gmail-Entwurf senden',
    reason:
      'Die E-Mail wird erst nach deiner Bestätigung versendet.',
    command:
      formatGmailSendDraftPreview(action)
  }
}
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

  if (
    GMAIL_WRITE_TOOL_NAMES.has(name)
  ) {
    let action

    try {
      if (name === 'gmail_send_draft') {
        action = await prepareGmailSendDraft(
          args,
          conversationId
        )
      } else if (
        name === 'gmail_delete_draft'
      ) {
        action = await prepareGmailDeleteDraft(
          args,
          conversationId
        )
      } else {
        throw new Error(
          `Unbekannte Gmail-Schreibaktion: ${name}`
        )
      }
    } catch (error) {
      const message =
        error?.message || String(error)

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'error',
        error: message
      })}\n\n`)

      return `Gmail error: ${message}`
    }

    const card =
      gmailActionCard(name, action)

    return new Promise(resolve => {
      const actionId = crypto.randomUUID()

      pendingGmailActions.set(
        actionId,
        {
          conversationId:
            Number(conversationId),
          toolName: name,
          args: {
            draftId: action.draftId
          },
          action,
          resolve
        }
      )

      setTimeout(() => {
        if (
          pendingGmailActions.has(actionId)
        ) {
          pendingGmailActions.delete(actionId)

          resolve(
            'Gmail action approval expired'
          )
        }
      }, 10 * 60 * 1000)

      res.write(`data: ${JSON.stringify({
        actionRequest: true,
        actionId,
        description:
          card.description,
        reason:
          card.reason,
        command:
          card.command,
        type: 'gmail',
        source: 'chat'
      })}\n\n`)
    })
  }

  if (GMAIL_TOOL_NAMES.has(name)) {
    res.write(`data: ${JSON.stringify({
      tool: name,
      status: 'running',
      query: args
    })}\n\n`)

    try {
      const result = await executeGmailTool(
        name,
        args,
        conversationId
      )

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'done'
      })}\n\n`)

      return result
    } catch (error) {
      const message =
        error?.message || String(error)

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'error',
        error: message
      })}\n\n`)

      return `Gmail error: ${message}`
    }
  }

  if (
    CALENDAR_EXTRA_WRITE_NAMES.has(name)
  ) {
    let action

    try {
      action = await prepareCalendarExtraAction(
        name,
        args,
        conversationId
      )
    } catch (error) {
      const message =
        error?.message || String(error)

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'error',
        error: message
      })}\n\n`)

      return `Calendar error: ${message}`
    }

    return new Promise(resolve => {
      const actionId = crypto.randomUUID()

      pendingCalendarActions.set(
        actionId,
        {
          conversationId:
            Number(conversationId),
          toolName: name,
          args: action,
          executor: 'extra',
          resolve
        }
      )

      setTimeout(() => {
        if (
          pendingCalendarActions.has(actionId)
        ) {
          pendingCalendarActions.delete(
            actionId
          )

          resolve(
            'Calendar action approval expired'
          )
        }
      }, 10 * 60 * 1000)

      res.write(`data: ${JSON.stringify({
        actionRequest: true,
        actionId,
        description:
          calendarExtraActionLabel(name),
        reason:
          'Die Kalenderaktion wird erst nach deiner Bestätigung ausgeführt.',
        command:
          formatCalendarExtraPreview(
            name,
            action
          ),
        type: 'calendar',
        source: 'chat'
      })}\n\n`)
    })
  }

  if (name === 'calendar_create_event') {
    const event =
      prepareCalendarCreateEvent(args)

    return new Promise(resolve => {
      const actionId = crypto.randomUUID()
      const preview =
        formatCalendarCreatePreview(event)

      pendingCalendarActions.set(
        actionId,
        {
          conversationId:
            Number(conversationId),
          toolName: name,
          args: event,
          resolve
        }
      )

      setTimeout(() => {
        if (
          pendingCalendarActions.has(actionId)
        ) {
          pendingCalendarActions.delete(
            actionId
          )

          resolve(
            'Calendar action approval expired'
          )
        }
      }, 10 * 60 * 1000)

      res.write(`data: ${JSON.stringify({
        actionRequest: true,
        actionId,
        description:
          'Google-Kalendertermin erstellen',
        reason:
          'Der Termin wird erst nach deiner Bestätigung gespeichert.',
        command: preview,
        type: 'calendar',
        source: 'chat'
      })}\n\n`)
    })
  }

  if (
    CALENDAR_EXTRA_TOOL_NAMES.has(name)
  ) {
    res.write(`data: ${JSON.stringify({
      tool: name,
      status: 'running',
      query: args
    })}\n\n`)

    try {
      const result =
        await executeCalendarExtraTool(
          name,
          args,
          conversationId
        )

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'done'
      })}\n\n`)

      return result
    } catch (error) {
      const message =
        error?.message || String(error)

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'error',
        error: message
      })}\n\n`)

      return `Calendar error: ${message}`
    }
  }

  if (CALENDAR_TOOL_NAMES.has(name)) {
    res.write(`data: ${JSON.stringify({
      tool: name,
      status: 'running',
      query: args
    })}\n\n`)

    try {
      const result = await executeCalendarTool(
        name,
        args,
        conversationId
      )

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'done'
      })}\n\n`)

      return result
    } catch (error) {
      const message =
        error?.message || String(error)

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'error',
        error: message
      })}\n\n`)

      return `Calendar error: ${message}`
    }
  }

  if (TASK_TOOL_NAMES.has(name)) {
    res.write(`data: ${JSON.stringify({
      tool: name,
      status: 'running',
      query: args
    })}\n\n`)

    try {
      const result = await executeTaskTool(
        name,
        args,
        conversationId
      )

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'done'
      })}\n\n`)

      return result
    } catch (error) {
      const message =
        error?.message || String(error)

      res.write(`data: ${JSON.stringify({
        tool: name,
        status: 'error',
        error: message
      })}\n\n`)

      return `Task error: ${message}`
    }
  }

  return `Unknown tool: ${name}`
}










// Main chat endpoint

// Auto-update memory after response (direct function call instead of HTTP)
function shouldForceMemoryUpdate(content) {
  return /\b(?:merk dir|merke dir|bitte merken|speichere (?:das|dies)|ab jetzt|von nun an|ich bevorzuge|vergiss|vergiss bitte|nicht mehr merken|aus (?:der )?memory entfernen)\b/i
    .test(String(content || ''))
}

async function updateMemory(userId, conversationId, model, force = false) {
  const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND role = ?')
    .get(conversationId, 'assistant').count

  // Regulär alle 10 Antworten, bei expliziten Memory-Aussagen sofort.
  if (!force && msgCount % 10 !== 0) return

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

  // System prompt with structured retrieval and legacy fallback
const selectedMemoryItems =
    selectMemoryItemsForContext(
      req.session.userId,
      content || '',
      {
        conversationId: convo.id,
        limit: 10,
        maxChars: 6000
      }
    )

  const structuredMemory =
    formatMemoryItemsForPrompt(
      selectedMemoryItems
    )

  if (
    process.env.MEMORY_DEBUG === '1' &&
    selectedMemoryItems.length
  ) {
    console.log(
      '[memory] selected:',
      selectedMemoryItems.map(item => ({
        id: item.id,
        type: item.type,
        scope: item.scope,
        score: Math.round(
          item.retrievalScore
        )
      }))
    )
  }

  let systemContent =
    convo.system_prompt || ''
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
  if (structuredMemory) {
    const structuredBlock =
      `[Relevant structured memories selected for this request:
${structuredMemory}
Use these as background context. If these memories fully answer the request, answer directly and do not call tools merely to verify them. Do not mention memory IDs or metadata unless the user explicitly asks.]`

    systemContent = systemContent
      ? `${systemContent}\n\n${structuredBlock}`
      : structuredBlock
  }


  const calendarToolPolicy = `[Calendar tool policy:
- Use calendar_list_events to identify an event when its event ID is unknown.
- When the user clearly requests creating, changing, or deleting an event and the target is unambiguous, call the appropriate calendar tool immediately.
- Never ask the user to reply "yes" or otherwise confirm in natural language.
- Calendar write tools automatically trigger the application's Approve/Deny interface.
- Ask a follow-up question only when the target event, date, or required time is genuinely ambiguous.
- Use calendar_find_free_time for questions about availability or open time windows.]`

  systemContent = systemContent
    ? `${systemContent}\n\n${calendarToolPolicy}`
    : calendarToolPolicy

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
      if (streamFn === streamZai || streamFn === streamResponses) {
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
            // Echte Zuordnung statt ausschließlich über Nachrichtenreihenfolge.
            ...(tc.id ? { tool_call_id: tc.id } : {}),
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
        updateMemory(
          req.session.userId,
          convo.id,
          convo.model,
          shouldForceMemoryUpdate(content)
        ).catch(err => console.error('Memory update failed:', err.message))
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

// Approve a pending terminal or calendar action
router.post(
  '/action/:actionId/approve',
  requireAuth,
  async (req, res) => {
    const actionId = req.params.actionId

    const calendarEntry =
      pendingCalendarActions.get(actionId)

    if (calendarEntry) {
      const ownedConversation = db.prepare(`
        SELECT id
        FROM conversations
        WHERE id = ? AND user_id = ?
      `).get(
        calendarEntry.conversationId,
        req.session.userId
      )

      if (!ownedConversation) {
        return res.status(404).json({
          error: 'Action not found or expired'
        })
      }

      pendingCalendarActions.delete(actionId)

      try {
        const executor =
          calendarEntry.executor === 'extra'
            ? executeCalendarExtraTool
            : executeCalendarTool

        const result =
          await executor(
            calendarEntry.toolName,
            calendarEntry.args,
            calendarEntry.conversationId
          )

        calendarEntry.resolve(result)

        return res.json({
          success: true,
          type: 'calendar'
        })
      } catch (error) {
        const message =
          error?.message || String(error)

        calendarEntry.resolve(
          `Calendar error: ${message}`
        )

        return res.status(
          error?.statusCode || 502
        ).json({
          error: message
        })
      }
    }

    const gmailEntry =
      pendingGmailActions.get(actionId)

    if (gmailEntry) {
      const ownedConversation = db.prepare(`
        SELECT id
        FROM conversations
        WHERE id = ? AND user_id = ?
      `).get(
        gmailEntry.conversationId,
        req.session.userId
      )

      if (!ownedConversation) {
        return res.status(404).json({
          error: 'Action not found or expired'
        })
      }

      pendingGmailActions.delete(actionId)

      try {
        const result = await executeGmailTool(
          gmailEntry.toolName,
          gmailEntry.args,
          gmailEntry.conversationId
        )

        gmailEntry.resolve(result)

        return res.json({
          success: true,
          type: 'gmail'
        })
      } catch (error) {
        const message =
          error?.message || String(error)

        gmailEntry.resolve(
          `Gmail error: ${message}`
        )

        return res.status(
          error?.statusCode || 502
        ).json({
          error: message
        })
      }
    }

    const entry =
      pendingTerminalActions.get(actionId)

    if (!entry) {
      return res.status(404).json({
        error: 'Action not found or expired'
      })
    }

    pendingTerminalActions.delete(actionId)

    const {
      command,
      conversationId,
      resolve
    } = entry

    exec(
      command,
      {
        timeout: 60000,
        cwd: '/root'
      },
      (err, stdout, stderr) => {
        const stripAnsi = value =>
          value
            .replace(
              /\x1B\[[0-9;]*[mGKHF]/g,
              ''
            )
            .replace(
              /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
              ''
            )

        const output = stripAnsi(
          (stdout || '').slice(0, 4000)
        )

        const errOutput = stripAnsi(
          (stderr || '').slice(0, 1000)
        )

        const result = err
          ? `Exit code ${err.code}:\n${errOutput}${output}`
          : output || '(no output)'

        if (conversationId) {
          db.prepare(`
            INSERT INTO messages (
              conversation_id,
              role,
              content
            )
            VALUES (?, 'assistant', ?)
          `).run(
            conversationId,
            '**Terminal:** `' +
              command +
              '`\n```\n' +
              result +
              '\n```'
          )
        }

        resolve(result)
      }
    )

    res.json({
      success: true,
      type: 'shell'
    })
  }
)

// Deny a pending terminal or calendar action
router.post(
  '/action/:actionId/deny',
  requireAuth,
  (req, res) => {
    const actionId = req.params.actionId

    const calendarEntry =
      pendingCalendarActions.get(actionId)

    if (calendarEntry) {
      pendingCalendarActions.delete(actionId)
      calendarEntry.resolve(
        'Calendar action denied by user'
      )

      return res.json({
        success: true,
        denied: true,
        type: 'calendar'
      })
    }

    const gmailEntry =
      pendingGmailActions.get(actionId)

    if (gmailEntry) {
      pendingGmailActions.delete(actionId)

      gmailEntry.resolve(
        'Gmail send action denied by user'
      )

      return res.json({
        success: true,
        denied: true,
        type: 'gmail'
      })
    }

    const entry =
      pendingTerminalActions.get(actionId)

    if (!entry) {
      return res.status(404).json({
        error: 'Action not found or expired'
      })
    }

    pendingTerminalActions.delete(actionId)
    entry.resolve(
      'Terminal action denied by user'
    )

    res.json({
      success: true,
      denied: true,
      type: 'shell'
    })
  }
)

// Get pending actions for a conversation
router.get(
  '/:conversationId/actions',
  requireAuth,
  (req, res) => {
    const conversationId =
      Number(req.params.conversationId)

    const conversation = db.prepare(`
      SELECT id
      FROM conversations
      WHERE id = ? AND user_id = ?
    `).get(
      conversationId,
      req.session.userId
    )

    if (!conversation) {
      return res.status(404).json({
        error: 'Conversation not found'
      })
    }

    const terminalActions =
      [...pendingTerminalActions.entries()]
        .filter(([, entry]) =>
          Number(entry.conversationId) ===
          conversationId
        )
        .map(([actionId, entry]) => ({
          actionId,
          description: entry.command,
          command: entry.command,
          type: 'shell',
          source: 'chat'
        }))

    const calendarActions =
      [...pendingCalendarActions.entries()]
        .filter(([, entry]) =>
          Number(entry.conversationId) ===
          conversationId
        )
        .map(([actionId, entry]) => ({
          actionId,
          description:
            entry.executor === 'extra'
              ? calendarExtraActionLabel(
                  entry.toolName
                )
              : 'Google-Kalendertermin erstellen',
          reason:
            'Die Kalenderaktion wird erst nach deiner Bestätigung ausgeführt.',
          command:
            entry.executor === 'extra'
              ? formatCalendarExtraPreview(
                  entry.toolName,
                  entry.args
                )
              : formatCalendarCreatePreview(
                  entry.args
                ),
          type: 'calendar',
          source: 'chat'
        }))

    const gmailActions =
      [...pendingGmailActions.entries()]
        .filter(([, entry]) =>
          Number(entry.conversationId) ===
          conversationId
        )
        .map(([actionId, entry]) => {
          const card = gmailActionCard(
            entry.toolName,
            entry.action
          )

          return {
            actionId,
            description:
              card.description,
            reason:
              card.reason,
            command:
              card.command,
            type: 'gmail',
            source: 'chat'
          }
        })

    res.json([
      ...terminalActions,
      ...calendarActions,
      ...gmailActions
    ])
  }
)

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
const MODEL_LIST_CACHE_MS = Math.max(
  5_000,
  Number(process.env.MODEL_LIST_CACHE_MS) || 60_000
)

const MODEL_PROVIDER_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.MODEL_PROVIDER_TIMEOUT_MS) || 4_000
)

let modelListCache = {
  models: null,
  expiresAt: 0
}

let modelListRefreshPromise = null

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    MODEL_PROVIDER_TIMEOUT_MS
  )

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function loadModelList() {
  const providers = [
    {
      name: 'ollama',
      enabled: true,
      load: async () => {
        const data = await fetchJsonWithTimeout(
          `${OLLAMA_URL}/api/tags`
        )
        return data.models || []
      }
    },
    {
      name: 'anthropic',
      enabled: Boolean(ANTHROPIC_KEY),
      load: async () => {
        const data = await fetchJsonWithTimeout(
          'https://api.anthropic.com/v1/models',
          {
            headers: {
              'x-api-key': ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01'
            }
          }
        )

        return (data.data || []).map(model => ({
          name: model.id,
          provider: 'anthropic'
        }))
      }
    },
    {
      name: 'openai',
      enabled: Boolean(OPENAI_KEY),
      load: async () => {
        const data = await fetchJsonWithTimeout(
          'https://api.openai.com/v1/models',
          {
            headers: {
              Authorization: `Bearer ${OPENAI_KEY}`
            }
          }
        )

        return (data.data || [])
          .map(model => model.id)
          .filter(id =>
            /^(gpt-5|gpt-4|o[0-9])/.test(id) &&
            !/audio|realtime|image|transcribe|tts|search|embedding/.test(id)
          )
          .sort()
          .reverse()
          .map(id => ({
            name: `openai/${id}`,
            provider: 'openai'
          }))
      }
    }
  ].filter(provider => provider.enabled)

  const results = await Promise.allSettled(
    providers.map(provider => provider.load())
  )

  const models = []

  results.forEach((result, index) => {
    const provider = providers[index]

    if (result.status === 'fulfilled') {
      models.push(...result.value)
      return
    }

    console.warn(JSON.stringify({
      level: 'warn',
      event: 'model_provider_unavailable',
      provider: provider.name,
      error: result.reason?.name === 'AbortError'
        ? `Timeout after ${MODEL_PROVIDER_TIMEOUT_MS}ms`
        : result.reason?.message || String(result.reason)
    }))
  })

  if (ZAI_KEY) {
    models.push(
      { name: 'zai/glm-5.2', provider: 'zai' },
      { name: 'zai/glm-5.1', provider: 'zai' },
      { name: 'zai/glm-4.7', provider: 'zai' }
    )
  }

  // Doppelte Modellnamen entfernen, Reihenfolge aber beibehalten.
  return Array.from(
    new Map(
      models
        .filter(model => model?.name)
        .map(model => [model.name, model])
    ).values()
  )
}

router.get('/models/list', requireAuth, async (req, res) => {
  const now = Date.now()

  if (
    modelListCache.models?.length &&
    modelListCache.expiresAt > now
  ) {
    res.setHeader('X-Model-Cache', 'HIT')
    return res.json(modelListCache.models)
  }

  if (!modelListRefreshPromise) {
    modelListRefreshPromise = loadModelList()
      .then(models => {
        if (models.length) {
          modelListCache = {
            models,
            expiresAt: Date.now() + MODEL_LIST_CACHE_MS
          }
        }

        return models
      })
      .finally(() => {
        modelListRefreshPromise = null
      })
  }

  try {
    const models = await modelListRefreshPromise

    if (models.length) {
      res.setHeader('X-Model-Cache', 'MISS')
      return res.json(models)
    }

    if (modelListCache.models?.length) {
      res.setHeader('X-Model-Cache', 'STALE')
      return res.json(modelListCache.models)
    }

    return res.status(503).json({
      error: 'Could not reach any model provider'
    })
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'model_list_refresh_failed',
      error: error?.message || String(error)
    }))

    if (modelListCache.models?.length) {
      res.setHeader('X-Model-Cache', 'STALE')
      return res.json(modelListCache.models)
    }

    return res.status(503).json({
      error: 'Could not reach any model provider'
    })
  }
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
