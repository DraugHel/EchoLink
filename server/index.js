import './loadEnv.js'  // MUSS erster Import bleiben — laedt .env bevor Routen process.env lesen
import express from 'express'
import session from 'express-session'
import connectSqlite3 from 'connect-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

import authRoutes from './routes/auth.js'
import conversationRoutes from './routes/conversations.js'
import chatRoutes from './routes/chat.js'
import memoryRoutes from './routes/memory.js'
import uploadRoutes, { cleanupOrphanedFiles } from './routes/uploads.js'
import hermesRoutes from './routes/hermes.js'
import externalRoutes from './routes/external.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SQLiteStore = connectSqlite3(session)

const PORT = process.env.PORT || 3000
const SECRET = process.env.SESSION_SECRET
if (!SECRET || SECRET === 'aender-mich' || SECRET === 'echolink-change-this-secret') {
  console.error('FATAL: SESSION_SECRET fehlt oder ist noch der Platzhalter. In .env setzen.')
  process.exit(1)
}
const DATA_DIR = path.join(__dirname, '..', 'data')

fs.mkdirSync(DATA_DIR, { recursive: true })

const app = express()
app.use(express.json({ limit: '100mb' }))

// Sessions stored in SQLite
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true
  }
}))

// API routes
app.use('/api/auth', authRoutes)
app.use('/api/conversations', conversationRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/memory', memoryRoutes)
app.use('/api/uploads', uploadRoutes)
app.use('/api/hermes', hermesRoutes)
app.use('/api/external', externalRoutes)

// Serve built frontend
const distPath = path.join(__dirname, '..', 'dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
} else {
  app.get('/', (req, res) => res.send('Run "npm run build" first to build the frontend.'))
}

const server = app.listen(PORT, () => {
  console.log(`EchoLink running on http://localhost:${PORT}`)
  // Clean up orphaned uploads on startup
  try { cleanupOrphanedFiles() } catch (e) { console.error('Upload cleanup failed:', e.message) }
})

// Clean up orphaned files every 6 hours
setInterval(() => {
  try { cleanupOrphanedFiles() } catch (e) { console.error('Upload cleanup failed:', e.message) }
}, 6 * 60 * 60 * 1000)

// 10 minute timeout for slow cloud models
server.setTimeout(10 * 60 * 1000)
