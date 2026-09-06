import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)

function runDbModule(dbPath) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import './server/db.js'"],
    {
      cwd: repoRoot,
      env: { ...process.env, ECHOLINK_DB_PATH: dbPath },
      encoding: 'utf8'
    }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test('fresh and existing databases receive additive chat_history_sources without losing rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echolink-chat-history-migration-'))
  try {
    const fresh = path.join(root, 'fresh.db')
    runDbModule(fresh)
    let db = new Database(fresh)
    let columns = db.prepare('PRAGMA table_info(messages)').all().map(row => row.name)
    assert.ok(columns.includes('chat_history_sources'))
    db.close()

    // Deliberately model an older EchoLink application DB before the additive
    // message metadata columns. Importing server/db.js must add the new column
    // without rebuilding the table or losing the existing chat row.
    const existing = path.join(root, 'existing.db')
    db = new Database(existing)
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE conversations (
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
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      INSERT INTO users(username, password_hash) VALUES ('u', 'x');
      INSERT INTO conversations(user_id, title, model) VALUES (1, 'keep', 'x');
      INSERT INTO messages(conversation_id, role, content) VALUES (1, 'user', 'preserve me');
    `)
    db.close()

    runDbModule(existing)
    db = new Database(existing)
    columns = db.prepare('PRAGMA table_info(messages)').all().map(row => row.name)
    assert.ok(columns.includes('chat_history_sources'))
    assert.ok(db.prepare("SELECT 1 FROM messages WHERE content = 'preserve me'").get())
    assert.equal(db.prepare("SELECT count(*) AS n FROM message_search WHERE message_search MATCH 'preserve'").get().n, 1)
    db.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
