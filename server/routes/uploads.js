import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'url'
import db from '../db.js'
import {
  getUploadKind,
  isImage,
  isSafeStoredUploadFilename,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_IMAGE_PIXELS,
  uploadAccepted,
  uploadExtension,
  uploadResponseHeaders,
  validateUploadOriginalName
} from '../lib/uploadPolicy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const router = Router()

function uploadError(
  message,
  statusCode = 400
) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.expose = true
  return error
}

function trackedUploadPaths(req) {
  if (!req.echolinkUploadPaths) {
    req.echolinkUploadPaths = new Set()
  }

  return req.echolinkUploadPaths
}

function trackUploadPath(req, filepath) {
  trackedUploadPaths(req).add(filepath)
  return filepath
}

function cleanupTrackedUploads(req) {
  const tracked = req.echolinkUploadPaths

  if (!(tracked instanceof Set)) return

  for (const filepath of tracked) {
    try {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath)
      }
    } catch {}
  }

  tracked.clear()
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(UPLOAD_DIR, String(req.session.userId))
    fs.mkdirSync(userDir, { recursive: true })
    req.echolinkUploadDirectory = userDir
    cb(null, userDir)
  },
  filename: (req, file, cb) => {
    const ext = uploadExtension(file.originalname)
    const nonce = crypto.randomBytes(12)
      .toString('hex')
    const name = `${Date.now()}_${nonce}${ext}`

    trackUploadPath(
      req,
      path.join(
        req.echolinkUploadDirectory,
        name
      )
    )

    cb(null, name)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_BYTES,
    files: MAX_UPLOAD_FILES,
    fields: 0,
    parts: MAX_UPLOAD_FILES,
    fieldNameSize: 32,
    headerPairs: 100
  },
  fileFilter: (req, file, cb) => {
    if (
      uploadAccepted(
        file.originalname,
        file.mimetype
      )
    ) {
      return cb(null, true)
    }

    cb(uploadError(
      'Dateityp oder Bild-MIME-Typ wird nicht unterstützt',
      415
    ))
  }
})

function normalizeMulterError(error) {
  if (error?.statusCode) return error

  if (!(error instanceof multer.MulterError)) {
    return uploadError(
      'Upload konnte nicht verarbeitet werden'
    )
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return uploadError(
      'Datei ist zu groß (maximal 25 MiB)',
      413
    )
  }

  if (
    error.code === 'LIMIT_FILE_COUNT' ||
    error.code === 'LIMIT_PART_COUNT'
  ) {
    return uploadError(
      `Maximal ${MAX_UPLOAD_FILES} Dateien pro Upload`,
      413
    )
  }

  return uploadError(
    'Ungültige Upload-Anfrage'
  )
}

function receiveUploadFiles(req, res, next) {
  const receive = upload.array(
    'files',
    MAX_UPLOAD_FILES
  )

  const cleanupIfUncommitted = () => {
    if (!req.echolinkUploadCommitted) {
      cleanupTrackedUploads(req)
    }
  }

  req.once('aborted', cleanupIfUncommitted)
  res.once('close', cleanupIfUncommitted)

  receive(req, res, error => {
    if (!error) return next()

    cleanupTrackedUploads(req)
    next(normalizeMulterError(error))
  })
}

// Upload — accepts images and files together
// Images are resized to max 1024px / JPEG 80% on upload to keep payloads small
router.post(
  '/',
  requireAuth,
  receiveUploadFiles,
  async (req, res, next) => {
    try {
      if (!Array.isArray(req.files) || !req.files.length) {
        throw uploadError('Keine Datei empfangen')
      }

      const files = []

      for (const f of req.files) {
        const originalName =
          validateUploadOriginalName(
            f.originalname
          )
        let filename = f.filename
        let size = f.size

        if (isImage(originalName)) {
          const sharp =
            (await import('sharp')).default
          const filepath = path.join(
            UPLOAD_DIR,
            String(req.session.userId),
            f.filename
          )
          const jpegName =
            f.filename.replace(/\.[^.]+$/, '') +
            '.jpg'
          const jpegPath = trackUploadPath(
            req,
            path.join(
              UPLOAD_DIR,
              String(req.session.userId),
              jpegName
            )
          )

          await sharp(filepath, {
            failOn: 'warning',
            limitInputPixels:
              MAX_UPLOAD_IMAGE_PIXELS,
            sequentialRead: true
          })
            .resize({
              width: 1024,
              height: 1024,
              fit: 'inside',
              withoutEnlargement: true
            })
            .jpeg({ quality: 80 })
            .toFile(jpegPath)

          fs.unlinkSync(filepath)
          filename = jpegName
          size = fs.statSync(jpegPath).size
        }

        files.push({
          filename,
          originalName,
          size,
          kind: getUploadKind(originalName)
        })
      }

      req.echolinkUploadCommitted = true
      res.json({ files })
    } catch (error) {
      cleanupTrackedUploads(req)

      if (!error?.statusCode) {
        error.statusCode = 400
        error.expose = true
        error.message =
          'Datei konnte nicht sicher verarbeitet werden'
      }

      next(error)
    }
  }
)

// Serve a file (auth required, scoped to user)
router.get('/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename

  if (!isSafeStoredUploadFilename(filename)) {
    return res.status(400).end()
  }

  const filepath = path.join(UPLOAD_DIR, String(req.session.userId), filename)
  if (!fs.existsSync(filepath)) return res.status(404).end()

  res.set(uploadResponseHeaders(filename))
  res.sendFile(filepath)
})

// Extract text from a file (PDF or text)
export async function extractTextFromFile(userId, filename, originalName) {
  const filepath = path.join(UPLOAD_DIR, String(userId), filename)
  if (!fs.existsSync(filepath)) return null

  // Cache-Hit? Verhindert PDF/docx/xlsx-Parsing bei jedem einzelnen Chat-Turn
  const cached = db.prepare('SELECT text FROM file_extractions WHERE filename = ? AND user_id = ?').get(filename, userId)
  if (cached) return cached.text

  const text = await doExtract(filepath, filename, originalName)
  if (text != null) {
    try {
      db.prepare('INSERT OR REPLACE INTO file_extractions (filename, user_id, text) VALUES (?, ?, ?)')
        .run(filename, userId, text)
    } catch {}
  }
  return text
}



async function parsePdfBuffer(buffer) {
  const pdfModule =
    await import('pdf-parse')

  // pdf-parse 1.x
  if (
    typeof pdfModule.default ===
    'function'
  ) {
    const result =
      await pdfModule.default(buffer)

    return String(
      result?.text || ''
    )
  }

  // pdf-parse 2.x
  if (
    typeof pdfModule.PDFParse ===
    'function'
  ) {
    const parser =
      new pdfModule.PDFParse({
        data: buffer
      })

    try {
      const result =
        await parser.getText()

      return String(
        result?.text || ''
      )
    } finally {
      if (
        typeof parser.destroy ===
        'function'
      ) {
        await parser.destroy()
      }
    }
  }

  throw new Error(
    'Unbekannte pdf-parse-API: ' +
    Object.keys(pdfModule).join(', ')
  )
}

export async function extractTextFromBuffer(
  buffer,
  filename,
  originalName = filename
) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError(
      'extractTextFromBuffer erwartet einen Buffer'
    )
  }

  const displayName =
    String(
      originalName ||
      filename ||
      'attachment'
    )

  const ext = path
    .extname(displayName)
    .toLowerCase()

  try {
    if (ext === '.pdf') {
      return await parsePdfBuffer(
        buffer
      )
    }

    if (ext === '.docx') {
      const mammoth =
        (await import('mammoth')).default

      const result =
        await mammoth.extractRawText({
          buffer
        })

      return result.value
    }

    if (
      ext === '.xlsx' ||
      ext === '.xls'
    ) {
      const XLSX =
        await import('xlsx')

      const workbook =
        XLSX.read(buffer, {
          type: 'buffer'
        })

      return workbook.SheetNames
        .map(name => {
          const worksheet =
            workbook.Sheets[name]

          return (
            `[Sheet: ${name}]\n` +
            XLSX.utils.sheet_to_csv(
              worksheet
            )
          )
        })
        .join('\n\n')
    }

    if (ext === '.pptx') {
      return (
        '[PPTX: text extraction not ' +
        'supported, file attached as reference]'
      )
    }

    if (
      [
        '.zip',
        '.tar',
        '.gz',
        '.7z',
        '.rar'
      ].includes(ext)
    ) {
      return null
    }

    return buffer.toString('utf8')
  } catch (error) {
    console.error(
      'Buffer text extraction failed for',
      displayName,
      error?.message || String(error)
    )

    return null
  }
}

async function doExtract(filepath, filename, originalName) {
  const ext = path.extname(filename).toLowerCase()
  try {
    if (ext === '.pdf') {
      return await parsePdfBuffer(
        fs.readFileSync(filepath)
      )
    } else if (ext === '.docx') {
      const mammoth = (await import('mammoth')).default
      const result = await mammoth.extractRawText({ path: filepath })
      return result.value
    } else if (ext === '.xlsx' || ext === '.xls') {
      const XLSX = await import('xlsx')
      const wb = XLSX.readFile(filepath)
      return wb.SheetNames.map(name => {
        const ws = wb.Sheets[name]
        return `[Sheet: ${name}]\n` + XLSX.utils.sheet_to_csv(ws)
      }).join('\n\n')
    } else if (ext === '.pptx') {
      // Basic PPTX text extraction — not supported, return notice
      return '[PPTX: text extraction not supported, file attached as reference]'
    } else if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) {
      return null // Archives not extracted
    } else {
      return fs.readFileSync(filepath, 'utf-8')
    }
  } catch (err) {
    console.error('Text extraction failed for', originalName, err.message)
    return null
  }
}

function removeFileAndCache(userId, fn) {
  const filepath = path.join(UPLOAD_DIR, String(userId), fn)
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
  try { db.prepare('DELETE FROM file_extractions WHERE filename = ? AND user_id = ?').run(fn, userId) } catch {}
}

// Delete files for a conversation
export function deleteFilesForConvo(userId, conversationId) {
  const messages = db.prepare('SELECT images FROM messages WHERE conversation_id = ?').all(conversationId)
  for (const msg of messages) {
    if (!msg.images) continue
    try {
      const items = JSON.parse(msg.images)
      // Could be array of strings (old format) or array of objects (new)
      for (const it of items) {
        removeFileAndCache(userId, typeof it === 'string' ? it : it.filename)
      }
    } catch {}
  }
}

// Delete files attached to a single message
export function deleteFilesForMessage(userId, images) {
  if (!images) return
  try {
    const items = JSON.parse(images)
    for (const it of items) {
      removeFileAndCache(userId, typeof it === 'string' ? it : it.filename)
    }
  } catch {}
}

// Clean up orphaned files (not referenced by any message)
export function cleanupOrphanedFiles() {
  const userDirs = fs.readdirSync(UPLOAD_DIR).filter(d => {
    const p = path.join(UPLOAD_DIR, d)
    return fs.statSync(p).isDirectory()
  })

  // Referenzen inklusive User-ID speichern, damit gleichnamige Dateien
  // verschiedener Benutzer nicht miteinander verwechselt werden.
  const referenced = new Set()
  const messages = db.prepare(`
    SELECT conversations.user_id, messages.images
    FROM messages
    JOIN conversations ON conversations.id = messages.conversation_id
    WHERE messages.images IS NOT NULL AND messages.images != ''
  `).all()
  for (const msg of messages) {
    try {
      const items = JSON.parse(msg.images)
      for (const it of items) {
        const filename = typeof it === 'string' ? it : it.filename
        if (filename) referenced.add(`${msg.user_id}/${filename}`)
      }
    } catch {}
  }

  for (const userId of userDirs) {
    const userDir = path.join(UPLOAD_DIR, userId)
    const filesOnDisk = fs.readdirSync(userDir)

    let removed = 0
    for (const file of filesOnDisk) {
      if (!referenced.has(`${userId}/${file}`)) {
        fs.unlinkSync(path.join(userDir, file))
        try {
          db.prepare('DELETE FROM file_extractions WHERE filename = ? AND user_id = ?')
            .run(file, Number(userId))
        } catch {}
        removed++
      }
    }
    if (removed > 0) console.log(`Cleaned ${removed} orphaned files for user ${userId}`)
  }
}

export { UPLOAD_DIR, isImage }
export default router
