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
    archived_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    source_task_id INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (source_task_id) REFERENCES scheduled_tasks(id) ON DELETE SET NULL
  );

  -- SQLite indiziert FKs nicht automatisch; wichtig fuer History-Queries + Cascade-Deletes
  CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, id);

  -- Cache fuer extrahierten Datei-Text (verhindert PDF/docx-Parsing bei jedem Chat-Turn)
  CREATE TABLE IF NOT EXISTS file_extractions (
    filename TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    conversation_id INTEGER,
    task_type TEXT NOT NULL DEFAULT 'reminder',
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_kind TEXT NOT NULL
      CHECK(schedule_kind IN ('once', 'interval', 'cron')),
    schedule_value TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Vienna',
    retention_days INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_run_at INTEGER,
    locked_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE,
    FOREIGN KEY (conversation_id)
      REFERENCES conversations(id)
      ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
    ON scheduled_tasks(enabled, next_run_at, locked_at);

  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user
    ON scheduled_tasks(user_id, id);

  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    status TEXT NOT NULL
      CHECK(status IN ('running', 'success', 'failed')),
    result TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    FOREIGN KEY (task_id)
      REFERENCES scheduled_tasks(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_task_runs_task
    ON task_runs(task_id, id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
    ON push_subscriptions(user_id, id);


  CREATE TABLE IF NOT EXISTS google_oauth_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT,
    expires_at INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    token_type TEXT NOT NULL DEFAULT 'Bearer',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE
  );
`)


// Strukturierte Einzel-Memories.
// users.memory bleibt vorerst als rückwärtskompatibler Fallback bestehen.
db.exec(`
  CREATE TABLE IF NOT EXISTS memory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,

    type TEXT NOT NULL DEFAULT 'fact'
      CHECK (
        type IN (
          'profile',
          'preference',
          'project',
          'instruction',
          'episodic',
          'temporary',
          'persona',
          'legacy',
          'fact'
        )
      ),

    scope TEXT NOT NULL DEFAULT 'global',
    content TEXT NOT NULL,

    confidence REAL NOT NULL DEFAULT 1.0
      CHECK (
        confidence >= 0.0
        AND confidence <= 1.0
      ),

    importance INTEGER NOT NULL DEFAULT 50
      CHECK (
        importance >= 0
        AND importance <= 100
      ),

    status TEXT NOT NULL DEFAULT 'active'
      CHECK (
        status IN (
          'active',
          'superseded',
          'archived'
        )
      ),

    source_conversation_id INTEGER,
    source_message_id INTEGER,
    supersedes_id INTEGER,

    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_confirmed_at INTEGER,
    expires_at INTEGER,

    metadata TEXT NOT NULL DEFAULT '{}',

    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE,

    FOREIGN KEY (source_conversation_id)
      REFERENCES conversations(id)
      ON DELETE SET NULL,

    FOREIGN KEY (source_message_id)
      REFERENCES messages(id)
      ON DELETE SET NULL,

    FOREIGN KEY (supersedes_id)
      REFERENCES memory_items(id)
      ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS
    idx_memory_items_user_status
    ON memory_items(
      user_id,
      status,
      importance DESC,
      updated_at DESC
    );

  CREATE INDEX IF NOT EXISTS
    idx_memory_items_user_scope
    ON memory_items(
      user_id,
      scope,
      status
    );

  CREATE INDEX IF NOT EXISTS
    idx_memory_items_source_conversation
    ON memory_items(
      source_conversation_id
    );

  CREATE INDEX IF NOT EXISTS
    idx_memory_items_expires
    ON memory_items(
      expires_at
    );
`);

// Add columns if they don't exist yet (for existing DBs)
try { db.exec(`ALTER TABLE users ADD COLUMN default_system_prompt TEXT DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN memory TEXT DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN images TEXT DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN usage TEXT DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN think TEXT DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE conversations ADD COLUMN archived_at INTEGER`) } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN source_task_id INTEGER`) } catch {}
try { db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN retention_days INTEGER`) } catch {}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_source_task_created
    ON messages(source_task_id, created_at);
`)



// Volltextindex fuer die globale Nachrichtensuche.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS message_search
  USING fts5(
    message_id UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS message_search_ai
  AFTER INSERT ON messages
  BEGIN
    INSERT INTO message_search(message_id, content)
    VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS message_search_ad
  AFTER DELETE ON messages
  BEGIN
    DELETE FROM message_search
    WHERE message_id = old.id;
  END;

  CREATE TRIGGER IF NOT EXISTS message_search_au
  AFTER UPDATE OF content ON messages
  BEGIN
    DELETE FROM message_search
    WHERE message_id = old.id;

    INSERT INTO message_search(message_id, content)
    VALUES (new.id, new.content);
  END;

  INSERT INTO message_search(message_id, content)
  SELECT messages.id, messages.content
  FROM messages
  WHERE NOT EXISTS (
    SELECT 1
    FROM message_search
    WHERE message_search.message_id = messages.id
  );

  DELETE FROM message_search
  WHERE NOT EXISTS (
    SELECT 1
    FROM messages
    WHERE messages.id = message_search.message_id
  );
`);


db.exec(`
  CREATE TABLE IF NOT EXISTS shift_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    column_number INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft', 'imported', 'partial')),
    model TEXT NOT NULL DEFAULT '',
    plan_start TEXT NOT NULL DEFAULT '',
    plan_end TEXT NOT NULL DEFAULT '',
    warnings TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS shift_import_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    work_date TEXT NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    start_time TEXT NOT NULL DEFAULT '',
    end_time TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    import_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(import_status IN ('pending', 'created', 'duplicate', 'error')),
    event_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (import_id)
      REFERENCES shift_imports(id)
      ON DELETE CASCADE,
    UNIQUE(import_id, work_date)
  );

  CREATE TABLE IF NOT EXISTS shift_calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    event_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    start_at TEXT NOT NULL DEFAULT '',
    end_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'created',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE,
    UNIQUE(user_id, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS
    idx_shift_imports_user_created
    ON shift_imports(user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS
    idx_shift_import_items_import_date
    ON shift_import_items(import_id, work_date);
`);


db.exec(`
  CREATE TABLE IF NOT EXISTS shift_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    import_id INTEGER NOT NULL,
    time_zone TEXT NOT NULL DEFAULT 'Europe/Vienna',
    status TEXT NOT NULL DEFAULT 'draft',
    summary_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch()),
    applied_at INTEGER,
    rolled_back_at INTEGER,
    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE,
    FOREIGN KEY (import_id)
      REFERENCES shift_imports(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS
    idx_shift_sync_runs_import
    ON shift_sync_runs(
      import_id,
      id DESC
    );

  CREATE TABLE IF NOT EXISTS shift_sync_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    import_item_id INTEGER,
    work_date TEXT NOT NULL DEFAULT '',
    action_type TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    event_id TEXT NOT NULL DEFAULT '',
    old_event_json TEXT NOT NULL DEFAULT 'null',
    new_event_json TEXT NOT NULL DEFAULT 'null',
    message TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (run_id)
      REFERENCES shift_sync_runs(id)
      ON DELETE CASCADE,
    FOREIGN KEY (import_item_id)
      REFERENCES shift_import_items(id)
      ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS
    idx_shift_sync_actions_run
    ON shift_sync_actions(
      run_id,
      work_date,
      id
    );
`);


db.exec(`
  CREATE TABLE IF NOT EXISTS shift_settings (
    user_id INTEGER PRIMARY KEY,
    calendar_id TEXT NOT NULL DEFAULT 'primary',
    calendar_name TEXT NOT NULL DEFAULT 'Primärkalender',
    reminder_minutes INTEGER DEFAULT NULL,
    location TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    codes_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE
  );
`);

for (const migration of [
  `ALTER TABLE shift_sync_runs
     ADD COLUMN calendar_id TEXT NOT NULL DEFAULT 'primary'`,
  `ALTER TABLE shift_sync_runs
     ADD COLUMN reminder_minutes INTEGER DEFAULT NULL`,
  `ALTER TABLE shift_calendar_events
     ADD COLUMN calendar_id TEXT NOT NULL DEFAULT 'primary'`
]) {
  try {
    db.exec(migration)
  } catch (error) {
    if (!String(error.message).includes('duplicate column name')) {
      console.error(
        'Shift settings migration error:',
        error.message
      )
    }
  }
}

try {
  db.exec(`
    ALTER TABLE shift_imports
    ADD COLUMN archived_at INTEGER DEFAULT NULL
  `)
} catch (error) {
  if (!String(error.message).includes('duplicate column name')) {
    console.error(
      'Shift history migration error:',
      error.message
    )
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS
    idx_shift_imports_user_archived
    ON shift_imports(
      user_id,
      archived_at,
      id DESC
    );
`)

// Bestehendes Markdown-Memory einmalig als Legacy-Eintrag übernehmen.
// Es wird nicht aus users.memory gelöscht.
try {
  const usersWithMemory = db.prepare(`
    SELECT id, memory
    FROM users
    WHERE trim(COALESCE(memory, '')) <> ''
  `).all()

  const hasItems = db.prepare(`
    SELECT 1
    FROM memory_items
    WHERE user_id = ?
    LIMIT 1
  `)

  const insertLegacy = db.prepare(`
    INSERT INTO memory_items (
      user_id,
      type,
      scope,
      content,
      confidence,
      importance,
      status,
      last_confirmed_at,
      metadata
    )
    VALUES (
      ?,
      'legacy',
      'global',
      ?,
      1.0,
      70,
      'active',
      unixepoch(),
      ?
    )
  `)

  const migrateLegacyMemory =
    db.transaction(users => {
      for (const user of users) {
        if (hasItems.get(user.id)) {
          continue
        }

        insertLegacy.run(
          user.id,
          user.memory,
          JSON.stringify({
            migratedFrom:
              'users.memory',
            migrationVersion:
              1
          })
        )
      }
    })

  migrateLegacyMemory(
    usersWithMemory
  )
} catch (error) {
  console.error(
    'Memory-items migration error:',
    error.message
  )
}

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

// Eine Quelle der Wahrheit fuer das Default-Modell
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'glm-5.1:cloud'

export default db
