#!/usr/bin/env node
// Usage: node scripts/adduser.js <username> <password>

import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'data', 'echolink.db')

const [,, username, password] = process.argv

if (!username || !password) {
  console.error('Usage: node scripts/adduser.js <username> <password>')
  process.exit(1)
}

if (!fs.existsSync(DB_PATH)) {
  console.error('Database not found. Start the server once first to initialize it.')
  process.exit(1)
}

const db = new Database(DB_PATH)
const hash = await bcrypt.hash(password, 12)

try {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash)
  console.log(`✓ User "${username}" created successfully.`)
} catch (err) {
  if (err.message.includes('UNIQUE')) {
    console.error(`User "${username}" already exists.`)
  } else {
    console.error('Error:', err.message)
  }
  process.exit(1)
}
