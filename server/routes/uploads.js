import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import db from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const router = Router()

const IMAGE_TYPES = /^image\/(jpeg|jpg|png|gif|webp)$/i
const TEXT_EXTS = new Set([
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.docx', '.xlsx', '.xls', '.pptx',
  '.txt', '.md', '.csv', '.json', '.xml', '.html', '.css', '.js', '.jsx', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.sh', '.bash',
  '.yml', '.yaml', '.toml', '.ini', '.conf', '.log', '.sql', '.php', '.swift', '.kt'
])

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(UPLOAD_DIR, String(req.session.userId))
    fs.mkdirSync(userDir, { recursive: true })
    cb(null, userDir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
    cb(null, name)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (IMAGE_TYPES.test(file.mimetype) || TEXT_EXTS.has(ext) || ext === '.pdf') {
      cb(null, true)
    } else {
      cb(new Error('Unsupported file type'))
    }
  }
})

function isImage(filename) {
  const ext = path.extname(filename).toLowerCase()
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)
}

function getFileKind(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (isImage(filename)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) return 'archive'
  if (['.docx', '.xlsx', '.xls', '.pptx'].includes(ext)) return 'text'
  return 'text'
}

// Upload — accepts images and files together
// Images are resized to max 1024px / JPEG 80% on upload to keep payloads small
router.post('/', requireAuth, upload.array('files', 5), async (req, res) => {
  const files = []
  for (const f of req.files) {
    let filename = f.filename
    let size = f.size
    if (isImage(f.originalname)) {
      try {
        const sharp = (await import('sharp')).default
        const filepath = path.join(UPLOAD_DIR, String(req.session.userId), f.filename)
        const jpegName = f.filename.replace(/\.[^.]+$/, '') + '.jpg'
        const jpegPath = path.join(UPLOAD_DIR, String(req.session.userId), jpegName)
        await sharp(filepath)
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(jpegPath)
        fs.unlinkSync(filepath) // remove original
        filename = jpegName
        size = fs.statSync(jpegPath).size
      } catch (err) {
        console.error('Image resize failed, keeping original:', err.message)
      }
    }
    files.push({
      filename,
      originalName: f.originalname,
      size,
      kind: getFileKind(f.originalname)
    })
  }
  res.json({ files })
})

// Serve a file (auth required, scoped to user)
router.get('/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename
  if (!/^[a-z0-9_.-]+$/i.test(filename) || filename.includes('..')) return res.status(400).end()
  const filepath = path.join(UPLOAD_DIR, String(req.session.userId), filename)
  if (!fs.existsSync(filepath)) return res.status(404).end()
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

async function doExtract(filepath, filename, originalName) {
  const ext = path.extname(filename).toLowerCase()
  try {
    if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse')).default
      const data = await pdfParse(fs.readFileSync(filepath))
      return data.text
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
