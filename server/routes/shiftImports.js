import { Router } from 'express'
import { fileURLToPath } from 'url'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'

import db from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { createCalendarEvent } from '../connectors/google/calendar.js'
import { OPENAI_KEY } from '../providers/openai-compatible.js'

const router = Router()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const IMAGE_ROOT = path.join(__dirname, '..', '..', 'data', 'shift-imports')
const RESPONSES_URL = 'https://api.openai.com/v1/responses'
const SUPPORTED_CODES = new Set(['1', '2', '3'])
const CODE_DEFAULTS = {
  '1': { startTime: '04:00', endTime: '12:00', title: 'Frühschicht' },
  '2': { startTime: '12:00', endTime: '20:00', title: 'Spätschicht' },
  '3': { startTime: '20:00', endTime: '04:00', title: 'Nachtschicht' }
}

fs.mkdirSync(IMAGE_ROOT, { recursive: true })

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp'])
    callback(allowed.has(file.mimetype) ? null : new Error('Nur JPEG, PNG und WebP werden unterstützt'), allowed.has(file.mimetype))
  }
})

function exposedError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function integer(value, name, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw exposedError(`${name} muss zwischen ${min} und ${max} liegen`)
  }
  return parsed
}

function validDate(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function zonedLocalToIso(dateText, timeText, timeZone) {
  const [year, month, day] = dateText.split('-').map(Number)
  const [hour, minute] = timeText.split(':').map(Number)
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  })
  let guess = wanted
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]))
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
    guess += wanted - shown
  }
  return new Date(guess).toISOString()
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 12)
}

function responseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim()
  const parts = []
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string' && content.text.trim()) parts.push(content.text)
    }
  }
  return parts.join('\n').trim()
}

function prompt(columnNumber) {
  return [
    'Du liest einen fotografierten Schichtplan.',
    `Lies ausschließlich Mitarbeiterspalte ${columnNumber}.`,
    'Gezählt wird ab der ersten Mitarbeiterspalte rechts von Datum und Tag.',
    'Ignoriere alle anderen Mitarbeiterspalten.',
    'Gib jede sichtbare Datumszeile genau einmal aus.',
    'Datum immer YYYY-MM-DD.',
    'Eindeutige rote handschriftliche Korrekturen haben Vorrang.',
    'Durchgestrichene Werte gelten nicht.',
    'Erfinde nichts. Bei Mehrdeutigkeit confidence unter 0.85 und note ausfüllen.',
    'Codes können 1, 2, 3, F, X, P, K, S, N oder anderer kurzer Text sein.',
    'Antworte ausschließlich als JSON passend zum Schema.'
  ].join('\n')
}

const schema = {
  type: 'object', additionalProperties: false,
  required: ['planStart', 'planEnd', 'detectedColumn', 'warnings', 'rows'],
  properties: {
    planStart: { type: 'string' },
    planEnd: { type: 'string' },
    detectedColumn: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
    rows: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['date', 'code', 'confidence', 'note'],
        properties: {
          date: { type: 'string' }, code: { type: 'string' },
          confidence: { type: 'number' }, note: { type: 'string' }
        }
      }
    }
  }
}

async function analyzeImage(imageBuffer, columnNumber) {
  if (!OPENAI_KEY) throw exposedError('OPENAI_API_KEY fehlt in der .env', 503)
  const model = process.env.SHIFT_IMPORT_MODEL || 'gpt-5.6'
  const base = {
    model, store: false, max_output_tokens: 12000,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt(columnNumber) },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`, detail: 'high' }
      ]
    }]
  }
  const bodies = [
    { ...base, text: { format: { type: 'json_schema', name: 'shift_plan_extraction', strict: true, schema } } },
    base
  ]
  let lastError
  for (let attempt = 0; attempt < bodies.length; attempt += 1) {
    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(bodies[attempt])
    })
    const raw = await response.text()
    let data
    try { data = JSON.parse(raw) } catch { data = null }
    if (!response.ok) {
      const message = data?.error?.message || raw.slice(0, 500) || `HTTP ${response.status}`
      lastError = exposedError(`Schichtplan-Analyse: ${message}`, response.status === 429 ? 429 : 502)
      if (attempt === 0 && response.status === 400) continue
      throw lastError
    }
    const text = responseText(data).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    try { return { model, data: JSON.parse(text) } }
    catch { lastError = exposedError('Die Bildanalyse lieferte ungültiges JSON', 502) }
  }
  throw lastError || exposedError('Schichtplan konnte nicht analysiert werden', 502)
}

function cleanRows(rows) {
  const byDate = new Map()
  for (const raw of Array.isArray(rows) ? rows : []) {
    const workDate = String(raw?.date || '').trim()
    if (!validDate(workDate)) continue
    const code = normalizeCode(raw?.code)
    const defaults = CODE_DEFAULTS[code] || { startTime: '', endTime: '', title: '' }
    const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0))
    byDate.set(workDate, {
      workDate, code, ...defaults, confidence,
      note: String(raw?.note || '').trim().slice(0, 1000),
      enabled: SUPPORTED_CODES.has(code) && confidence >= 0.85 ? 1 : 0
    })
  }
  return [...byDate.values()].sort((a, b) => a.workDate.localeCompare(b.workDate)).slice(0, 120)
}

function serializeImport(row) {
  let warnings = []
  try { warnings = JSON.parse(row.warnings || '[]') } catch {}
  return {
    id: row.id, filename: row.filename, originalName: row.original_name,
    columnNumber: row.column_number, status: row.status, model: row.model,
    planStart: row.plan_start, planEnd: row.plan_end, warnings,
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

function serializeItem(row) {
  return {
    id: row.id, importId: row.import_id, workDate: row.work_date,
    code: row.code, startTime: row.start_time, endTime: row.end_time,
    title: row.title, confidence: row.confidence, note: row.note,
    enabled: Boolean(row.enabled), importStatus: row.import_status,
    eventId: row.event_id, error: row.error
  }
}

function ownedImport(importId, userId) {
  return db.prepare('SELECT * FROM shift_imports WHERE id = ? AND user_id = ?').get(importId, userId)
}

function withItems(importRow) {
  const items = db.prepare('SELECT * FROM shift_import_items WHERE import_id = ? ORDER BY work_date, id').all(importRow.id)
  return { import: serializeImport(importRow), items: items.map(serializeItem) }
}

function editable(raw) {
  const id = integer(raw?.id, 'Zeilen-ID', 1, Number.MAX_SAFE_INTEGER)
  const workDate = String(raw?.workDate || '').trim()
  if (!validDate(workDate)) throw exposedError(`Ungültiges Datum in Zeile ${id}`)
  const code = normalizeCode(raw?.code)
  if (!code) throw exposedError(`Schichtcode in Zeile ${id} fehlt`)
  const startTime = String(raw?.startTime || '').trim()
  const endTime = String(raw?.endTime || '').trim()
  const enabled = Boolean(raw?.enabled)
  if (enabled && !SUPPORTED_CODES.has(code)) throw exposedError(`Code ${code} kann nicht automatisch importiert werden`)
  if (enabled && (!validTime(startTime) || !validTime(endTime))) throw exposedError(`Start oder Ende in Zeile ${id} ist ungültig`)
  const title = String(raw?.title || '').trim().slice(0, 300)
  if (enabled && !title) throw exposedError(`Titel in Zeile ${id} fehlt`)
  return { id, workDate, code, startTime, endTime, title, enabled: enabled ? 1 : 0, note: String(raw?.note || '').trim().slice(0, 1000) }
}

function fingerprint(userId, item) {
  return crypto.createHash('sha256').update([userId, item.work_date, item.start_time, item.end_time].join('|')).digest('hex')
}

router.get('/latest', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM shift_imports WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.session.userId)
  res.json(row ? withItems(row) : { import: null, items: [] })
})

router.post('/analyze', requireAuth, upload.single('image'), async (req, res) => {
  let storedPath = ''
  try {
    if (!req.file?.buffer) throw exposedError('Bitte ein Schichtplanbild auswählen')
    const columnNumber = integer(req.body?.columnNumber || 1, 'Mitarbeiterspalte', 1, 100)
    const sharp = (await import('sharp')).default
    const normalized = await sharp(req.file.buffer).rotate().resize({ width: 2600, height: 2600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90, mozjpeg: true }).toBuffer()
    const userDir = path.join(IMAGE_ROOT, String(req.session.userId))
    fs.mkdirSync(userDir, { recursive: true })
    const filename = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.jpg`
    storedPath = path.join(userDir, filename)
    fs.writeFileSync(storedPath, normalized, { mode: 0o600 })

    const extraction = await analyzeImage(normalized, columnNumber)
    const rows = cleanRows(extraction.data?.rows)
    if (!rows.length) throw exposedError('Keine gültigen Datumszeilen erkannt', 422)
    const warnings = Array.isArray(extraction.data?.warnings)
      ? extraction.data.warnings.map(value => String(value || '').trim().slice(0, 500)).filter(Boolean).slice(0, 20)
      : []
    const planStart = validDate(extraction.data?.planStart) ? extraction.data.planStart : rows[0].workDate
    const planEnd = validDate(extraction.data?.planEnd) ? extraction.data.planEnd : rows.at(-1).workDate

    const create = db.transaction(() => {
      const result = db.prepare(`INSERT INTO shift_imports
        (user_id, filename, original_name, column_number, status, model, plan_start, plan_end, warnings, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, unixepoch(), unixepoch())`)
        .run(req.session.userId, filename, String(req.file.originalname || 'Schichtplan').slice(0, 300), columnNumber, extraction.model, planStart, planEnd, JSON.stringify(warnings))
      const importId = Number(result.lastInsertRowid)
      const insert = db.prepare(`INSERT INTO shift_import_items
        (import_id, work_date, code, start_time, end_time, title, confidence, note, enabled, import_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch())`)
      for (const row of rows) insert.run(importId, row.workDate, row.code, row.startTime, row.endTime, row.title, row.confidence, row.note, row.enabled)
      return importId
    })
    const importId = create()
    res.json(withItems(ownedImport(importId, req.session.userId)))
  } catch (error) {
    if (storedPath && fs.existsSync(storedPath)) try { fs.unlinkSync(storedPath) } catch {}
    console.error('Shift plan analysis failed:', error?.message || error)
    res.status(error?.statusCode || 500).json({ error: error?.message || 'Schichtplan-Analyse fehlgeschlagen' })
  }
})

router.put('/:id/items', requireAuth, (req, res) => {
  try {
    const importId = integer(req.params.id, 'Import-ID', 1, Number.MAX_SAFE_INTEGER)
    const importRow = ownedImport(importId, req.session.userId)
    if (!importRow) return res.status(404).json({ error: 'Schichtimport nicht gefunden' })
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : []
    if (!rawItems.length || rawItems.length > 120) throw exposedError('Ungültige Anzahl an Schichtzeilen')
    const items = rawItems.map(editable)
    const exists = db.prepare('SELECT id FROM shift_import_items WHERE id = ? AND import_id = ?')
    const update = db.prepare(`UPDATE shift_import_items SET work_date = ?, code = ?, start_time = ?, end_time = ?, title = ?, note = ?, enabled = ?, error = '', updated_at = unixepoch() WHERE id = ? AND import_id = ?`)
    db.transaction(() => {
      for (const item of items) {
        if (!exists.get(item.id, importId)) throw exposedError(`Zeile ${item.id} gehört nicht zu diesem Import`)
        update.run(item.workDate, item.code, item.startTime, item.endTime, item.title, item.note, item.enabled, item.id, importId)
      }
      db.prepare('UPDATE shift_imports SET updated_at = unixepoch() WHERE id = ?').run(importId)
    })()
    res.json(withItems(ownedImport(importId, req.session.userId)))
  } catch (error) {
    res.status(error?.statusCode || 500).json({ error: error?.message || 'Vorschau konnte nicht gespeichert werden' })
  }
})

router.post('/:id/import', requireAuth, async (req, res) => {
  try {
    const importId = integer(req.params.id, 'Import-ID', 1, Number.MAX_SAFE_INTEGER)
    const importRow = ownedImport(importId, req.session.userId)
    if (!importRow) return res.status(404).json({ error: 'Schichtimport nicht gefunden' })
    const timeZone = String(req.body?.timeZone || 'Europe/Vienna').trim()
    try { new Intl.DateTimeFormat('de-AT', { timeZone }).format(new Date()) }
    catch { throw exposedError('Ungültige Zeitzone') }
    const items = db.prepare('SELECT * FROM shift_import_items WHERE import_id = ? AND enabled = 1 ORDER BY work_date, id').all(importId)
    if (!items.length) throw exposedError('Keine Schichten zum Import ausgewählt')
    if (items.length > 100) throw exposedError('Maximal 100 Schichten pro Import')
    const results = []

    for (const item of items) {
      if (!SUPPORTED_CODES.has(item.code) || !validDate(item.work_date) || !validTime(item.start_time) || !validTime(item.end_time)) {
        results.push({ itemId: item.id, status: 'error', error: 'Code, Datum oder Uhrzeit ungültig' })
        continue
      }
      const hash = fingerprint(req.session.userId, item)
      const duplicate = db.prepare("SELECT event_id FROM shift_calendar_events WHERE user_id = ? AND fingerprint = ? AND status = 'created'").get(req.session.userId, hash)
      if (duplicate) {
        db.prepare("UPDATE shift_import_items SET import_status = 'duplicate', event_id = ?, error = '', updated_at = unixepoch() WHERE id = ?").run(duplicate.event_id || '', item.id)
        results.push({ itemId: item.id, status: 'duplicate', eventId: duplicate.event_id || '' })
        continue
      }
      const endDate = item.end_time <= item.start_time ? addDays(item.work_date, 1) : item.work_date
      const start = zonedLocalToIso(item.work_date, item.start_time, timeZone)
      const end = zonedLocalToIso(endDate, item.end_time, timeZone)
      try {
        const created = await createCalendarEvent(req.session.userId, {
          title: item.title, start, end, timeZone,
          description: [`Schichtcode: ${item.code}`, `Plan-Datum: ${item.work_date}`, `EchoLink-Schichtimport:${hash}`].join('\n')
        })
        db.prepare(`INSERT INTO shift_calendar_events
          (user_id, fingerprint, event_id, title, start_at, end_at, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'created', unixepoch(), unixepoch())
          ON CONFLICT(user_id, fingerprint) DO UPDATE SET event_id = excluded.event_id, title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at, status = 'created', updated_at = unixepoch()`)
          .run(req.session.userId, hash, created.id || '', item.title, start, end)
        db.prepare("UPDATE shift_import_items SET import_status = 'created', event_id = ?, error = '', updated_at = unixepoch() WHERE id = ?").run(created.id || '', item.id)
        results.push({ itemId: item.id, status: 'created', eventId: created.id || '', link: created.link || '' })
      } catch (error) {
        const message = error?.message || String(error)
        db.prepare("UPDATE shift_import_items SET import_status = 'error', error = ?, updated_at = unixepoch() WHERE id = ?").run(message.slice(0, 1000), item.id)
        results.push({ itemId: item.id, status: 'error', error: message })
      }
    }

    const summary = {
      created: results.filter(item => item.status === 'created').length,
      duplicates: results.filter(item => item.status === 'duplicate').length,
      errors: results.filter(item => item.status === 'error').length
    }
    db.prepare('UPDATE shift_imports SET status = ?, updated_at = unixepoch() WHERE id = ?').run(summary.errors ? 'partial' : 'imported', importId)
    res.json({ ...withItems(ownedImport(importId, req.session.userId)), summary, results })
  } catch (error) {
    console.error('Shift calendar import failed:', error?.message || error)
    res.status(error?.statusCode || 500).json({ error: error?.message || 'Kalenderimport fehlgeschlagen' })
  }
})

export default router
