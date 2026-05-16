import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import db from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const router = Router()

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' })
  next()
}

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
    if (IMAGE_TYPES.test(file.mimetype) || TEXT_EXTS.has(ext) || ext === '.pdf' || ['.zip','.tar','.gz','.7z','.rar','.docx','.xlsx','.xls','.pptx'].includes(ext)) {
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
router.post('/', requireAuth, upload.array('files', 5), (req, res) => {
  const files = req.files.map(f => ({
    filename: f.filename,
    originalName: f.originalname,
    size: f.size,
    kind: getFileKind(f.originalname)
  }))
  res.json({ files })
})

// Serve a file (auth required, scoped to user)
router.get('/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename
  if (!/^[a-z0-9_.-]+$/i.test(filename)) return res.status(400).end()
  const filepath = path.join(UPLOAD_DIR, String(req.session.userId), filename)
  if (!fs.existsSync(filepath)) return res.status(404).end()
  res.sendFile(filepath)
})

// Extract text from a file (PDF or text)
export async function extractTextFromFile(userId, filename, originalName) {
  const filepath = path.join(UPLOAD_DIR, String(userId), filename)
  if (!fs.existsSync(filepath)) return null

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

// Delete files for a conversation
export function deleteFilesForConvo(userId, conversationId) {
  const messages = db.prepare('SELECT images FROM messages WHERE conversation_id = ?').all(conversationId)
  for (const msg of messages) {
    if (!msg.images) continue
    try {
      const items = JSON.parse(msg.images)
      // Could be array of strings (old format) or array of objects (new)
      for (const it of items) {
        const fn = typeof it === 'string' ? it : it.filename
        const filepath = path.join(UPLOAD_DIR, String(userId), fn)
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
      }
    } catch {}
  }
}

export { UPLOAD_DIR, isImage }
export default router
