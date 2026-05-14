import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'data', 'echolink.db')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    default_system_prompt TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT 'New Conversation',
    model TEXT NOT NULL DEFAULT 'llama3',
    system_prompt TEXT DEFAULT '',
    temperature REAL DEFAULT 0.7,
    top_k INTEGER DEFAULT 40,
    top_p REAL DEFAULT 0.9,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
`)

// Add columns if they don't exist yet (for existing DBs)
try { db.exec(`ALTER TABLE users ADD COLUMN default_system_prompt TEXT DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN memory TEXT DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN images TEXT DEFAULT ''`) } catch {}

// One-time migration: strip memory blocks from existing system_prompts
try {
  const convos = db.prepare(`SELECT id, system_prompt FROM conversations WHERE system_prompt LIKE '%[What you know about the user%'`).all()
  for (const c of convos) {
    const cleaned = c.system_prompt
      .replace(/\n*\[What you know about the user[\s\S]*?\]/g, '')
      .trim()
    db.prepare('UPDATE conversations SET system_prompt = ? WHERE id = ?').run(cleaned, c.id)
  }
  if (convos.length > 0) console.log(`Migrated ${convos.length} conversations to remove memory from system_prompt`)
} catch (e) { console.error('Migration error:', e.message) }

export default db
