import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'

function bootDb(dbPath) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const { default: db } = await import('./server/db.js'); db.close();"
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ECHOLINK_DB_PATH: dbPath },
      encoding: 'utf8'
    }
  )
  assert.equal(child.status, 0, child.stderr || child.stdout)
}

function columns(dbPath) {
  const db = new Database(dbPath)
  try {
    return db.prepare('PRAGMA table_info(conversation_summaries)').all().map(row => row.name)
  } finally {
    db.close()
  }
}

test('conversation_summaries is created on a fresh test DB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echolink-summary-migration-fresh-'))
  const dbPath = path.join(root, 'fresh.db')
  try {
    bootDb(dbPath)
    const names = columns(dbPath)
    for (const name of [
      'source_conversation_id',
      'source_hash',
      'revision',
      'continued_conversation_id',
      'continued_revision',
      'continue_request_id',
      'continue_content_hash'
    ]) {
      assert.ok(names.includes(name), `${name} must exist`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('existing test DB gains missing idempotency columns additively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echolink-summary-migration-existing-'))
  const dbPath = path.join(root, 'existing.db')
  try {
    // First create a representative existing EchoLink DB with all ordinary tables.
    bootDb(dbPath)

    // Simulate an earlier local summary-table draft. db.js must not rewrite
    // existing data; it should only add the three missing continuation columns.
    const db = new Database(dbPath)
    db.exec(`
      DROP TABLE conversation_summaries;
      CREATE TABLE conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        source_conversation_id INTEGER NOT NULL UNIQUE,
        content TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        source_last_message_id INTEGER,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        source_hash TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        continued_conversation_id INTEGER
      );
      INSERT INTO conversation_summaries (
        user_id, source_conversation_id, content, model,
        prompt_version, source_hash
      ) VALUES (7, 8, 'draft stays', 'plain-model', 'old', 'hash');
    `)
    db.close()

    bootDb(dbPath)
    const names = columns(dbPath)
    for (const name of [
      'continued_revision',
      'continue_request_id',
      'continue_content_hash'
    ]) {
      assert.ok(names.includes(name), `${name} must be added`)
    }

    const verify = new Database(dbPath, { readonly: true })
    const row = verify.prepare('SELECT content, model, prompt_version, source_hash FROM conversation_summaries WHERE source_conversation_id = 8').get()
    verify.close()
    assert.deepEqual(row, {
      content: 'draft stays',
      model: 'plain-model',
      prompt_version: 'old',
      source_hash: 'hash'
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
