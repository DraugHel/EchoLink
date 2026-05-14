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
import uploadRoutes from './routes/uploads.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SQLiteStore = connectSqlite3(session)

const PORT = process.env.PORT || 3000
const SECRET = process.env.SESSION_SECRET || 'echolink-change-this-secret'
const DATA_DIR = path.join(__dirname, '..', 'data')

fs.mkdirSync(DATA_DIR, { recursive: true })

// Clear all sessions on startup to avoid stale cache issues
try {
  const sessDb = new (await import('better-sqlite3')).default(path.join(DATA_DIR, 'sessions.db'))
  sessDb.exec('DELETE FROM sessions')
  sessDb.close()
  console.log('Sessions cleared on startup')
} catch {}

const app = express()
app.use(express.json())

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
})

// 10 minute timeout for slow cloud models
server.setTimeout(10 * 60 * 1000)
