import './loadEnv.js'  // MUSS erster Import bleiben — laedt .env bevor Routen process.env lesen
import express from 'express'
import session from 'express-session'
import connectSqlite3 from 'connect-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import crypto from 'node:crypto'

import authRoutes from './routes/auth.js'
import conversationRoutes from './routes/conversations.js'
import chatRoutes from './routes/chat.js'
import memoryRoutes from './routes/memory.js'
import pushRoutes from './routes/push.js'
import taskRoutes from './routes/tasks.js'
import uploadRoutes, { cleanupOrphanedFiles } from './routes/uploads.js'
import externalRoutes from './routes/external.js'
import systemRoutes from './routes/system.js'
import googleRoutes from './routes/google.js'
import shiftImportRoutes from './routes/shiftImports.js'
import shiftMultipageRoutes from './routes/shiftMultipage.js'
import shiftSyncRoutes from './routes/shiftSync.js'
import shiftSettingsRoutes from './routes/shiftSettings.js'
import shiftHistoryRoutes from './routes/shiftHistory.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SQLiteStore = connectSqlite3(session)

const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || '127.0.0.1'
const SECRET = process.env.SESSION_SECRET
if (!SECRET || SECRET === 'aender-mich' || SECRET === 'echolink-change-this-secret') {
  console.error('FATAL: SESSION_SECRET fehlt oder ist noch der Platzhalter. In .env setzen.')
  process.exit(1)
}
const DATA_DIR = path.join(__dirname, '..', 'data')

fs.mkdirSync(DATA_DIR, { recursive: true })

const app = express()

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint()
  const requestId = crypto.randomUUID()

  req.requestId = requestId
  res.setHeader('X-Request-ID', requestId)

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

    // Nur den Pfad loggen, niemals Query-Parameter mit moeglichen Tokens.
    const pathname = req.originalUrl?.split('?')[0] || req.path || '/'

    console.log(JSON.stringify({
      level: res.statusCode >= 500
        ? 'error'
        : res.statusCode >= 400
          ? 'warn'
          : 'info',
      event: 'http_request',
      requestId,
      method: req.method,
      path: pathname,
      status: res.statusCode,
      durationMs: Number(elapsedMs.toFixed(1)),
      userId: req.session?.userId || null
    }))
  })

  next()
}

app.use(requestLogger)

// Nur aktivieren, wenn EchoLink hinter einem vertrauenswuerdigen
// Reverse Proxy wie Nginx, Caddy oder Cloudflare betrieben wird.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1)
}

app.disable('x-powered-by')
app.use(express.json({ limit: '5mb' }))

// Sessions stored in SQLite
app.use(session({
  name: 'echolink.sid',
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true'
  }
}))

// API routes
app.use('/api/auth', authRoutes)
app.use('/api/conversations', conversationRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/memory', memoryRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/tasks', taskRoutes)
app.use('/api/uploads', uploadRoutes)
app.use('/api/external', externalRoutes)
app.use('/api/system', systemRoutes)
app.use('/api/google', googleRoutes)
app.use('/api/shift-imports', shiftImportRoutes)
app.use('/api/shift-multipage', shiftMultipageRoutes)
app.use('/api/shift-sync', shiftSyncRoutes)
app.use('/api/shift-settings', shiftSettingsRoutes)
app.use('/api/shift-history', shiftHistoryRoutes)

// Unbekannte API-Routen immer als JSON beantworten.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API route not found',
    requestId: req.requestId
  })
})

// Zentraler Fehler-Handler. Muss nach allen API-Routen stehen.
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown'

  console.error(JSON.stringify({
    level: 'error',
    event: 'unhandled_request_error',
    requestId,
    method: req.method,
    path: req.originalUrl?.split('?')[0] || req.path,
    userId: req.session?.userId || null,
    error: err?.message || String(err),
    stack: process.env.NODE_ENV === 'production'
      ? undefined
      : err?.stack
  }))

  // Bei SSE oder anderen bereits gestarteten Responses darf kein
  // zweiter JSON-Response mehr geschrieben werden.
  if (res.headersSent) {
    return next(err)
  }

  res.status(err?.statusCode || err?.status || 500).json({
    error: err?.expose ? err.message : 'Internal server error',
    requestId
  })
})

// Serve built frontend
const distPath = path.join(__dirname, '..', 'dist')
if (fs.existsSync(distPath)) {
  // EchoLink Phase 4.1: frontend cache policy
  //
  // Vite versieht Produktions-Assets mit einem Inhalts-Hash.
  // Diese Dateien duerfen deshalb dauerhaft gecacht werden.
  app.use(
    '/assets',
    express.static(
      path.join(distPath, 'assets'),
      {
        maxAge: '1y',
        immutable: true
      }
    )
  )

  // App-Shell, Service Worker und Manifest muessen nach einem
  // Deployment stets neu validiert werden. Sonstige statische
  // Dateien behalten die vorsichtige Express-Standardregel.
  app.use(
    express.static(
      distPath,
      {
        setHeaders(res, filePath) {
          const filename = path.basename(filePath)

          if (
            filename === 'index.html' ||
            filename === 'sw.js' ||
            filename === 'manifest.json'
          ) {
            res.setHeader(
              'Cache-Control',
              'no-cache, max-age=0, must-revalidate'
            )
          }
        }
      }
    )
  )

  app.get('*', (req, res) => {
    res.setHeader(
      'Cache-Control',
      'no-cache, max-age=0, must-revalidate'
    )
    res.sendFile(path.join(distPath, 'index.html'))
  })
} else {
  app.get('/', (req, res) => res.send('Run "npm run build" first to build the frontend.'))
}

const server = app.listen(PORT, HOST, () => {


  console.log(`EchoLink running on http://${HOST}:${PORT}`)
  // Clean up orphaned uploads on startup
  try { cleanupOrphanedFiles() } catch (e) { console.error('Upload cleanup failed:', e.message) }
})

// Clean up orphaned files every 6 hours
setInterval(() => {
  try { cleanupOrphanedFiles() } catch (e) { console.error('Upload cleanup failed:', e.message) }
}, 6 * 60 * 60 * 1000)

// 10 minute timeout for slow cloud models
server.setTimeout(10 * 60 * 1000)
