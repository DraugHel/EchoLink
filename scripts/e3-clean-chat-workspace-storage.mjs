#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import {
  acquireManagerLock
} from '../server/e3/workspaces/managerLock.js'
import {
  cleanupTerminalWorkspaceStorage
} from '../server/e3/chat/workspaceStorageCleanup.js'

const CHAT_ROOT = '/var/lib/echolink-e3/chat'
const SESSIONS_ROOT = join(CHAT_ROOT, 'sessions')
const LOCKS_ROOT = join(CHAT_ROOT, 'locks')
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'DENIED',
  'VALIDATION_FAILED',
  'FAILED'
])

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    )
  }
  return value
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

function sha256(value) {
  return createHash('sha256')
    .update(value)
    .digest('hex')
}

function readMetadata(sessionRoot) {
  const path = join(sessionRoot, 'session.json')
  const stat = lstatSync(path)

  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error('unsafe session metadata file')
  }

  const metadata = JSON.parse(
    readFileSync(path, 'utf8')
  )
  const {
    metadataSha256,
    ...unsigned
  } = metadata

  if (
    typeof metadataSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(metadataSha256) ||
    sha256(canonicalJson(unsigned)) !== metadataSha256
  ) {
    throw new Error('session metadata digest mismatch')
  }

  return metadata
}

function cleanupEvidence(metadata) {
  if (metadata.status === 'COMPLETED') {
    return metadata.export?.cleanup
  }
  if (
    metadata.status === 'DENIED' ||
    metadata.status === 'VALIDATION_FAILED'
  ) {
    return metadata.failure?.cleanup
  }
  if (metadata.status === 'FAILED') {
    if (metadata.workspaceFencingToken === null) {
      return {
        removed: false,
        alreadyAbsent: true
      }
    }
    return {
      removed:
        metadata.failure?.recovery?.workspaceRemoved === true,
      alreadyAbsent:
        metadata.failure?.recovery
          ?.workspaceAlreadyAbsent === true
    }
  }
  return null
}

function main() {
  const mode = process.argv[2] || '--dry-run'
  if (!['--dry-run', '--apply'].includes(mode)) {
    throw new Error(
      'usage: e3-clean-chat-workspace-storage.mjs [--dry-run | --apply]'
    )
  }
  if (process.getuid?.() !== 0) {
    throw new Error('root operator identity required')
  }
  if (!existsSync(SESSIONS_ROOT)) {
    console.log('E3_CHAT_STORAGE_CLEANUP_EMPTY=1')
    return
  }

  const apply = mode === '--apply'
  let removedCount = 0
  let alreadyAbsentCount = 0
  let skippedCount = 0
  let reclaimedBytes = 0

  for (const entry of readdirSync(SESSIONS_ROOT, {
    withFileTypes: true
  })) {
    if (
      !entry.isDirectory() ||
      !UUID_PATTERN.test(entry.name)
    ) {
      continue
    }

    const sessionId = entry.name
    const sessionRoot = join(SESSIONS_ROOT, sessionId)
    let lock
    let database

    try {
      const metadata = readMetadata(sessionRoot)
      if (!TERMINAL_STATUSES.has(metadata.status)) {
        skippedCount += 1
        console.log(
          `SKIP_SESSION=${sessionId} REASON=NON_TERMINAL STATUS=${metadata.status}`
        )
        continue
      }

      const evidence = cleanupEvidence(metadata)
      if (
        !evidence ||
        (
          evidence.removed !== true &&
          evidence.alreadyAbsent !== true
        )
      ) {
        skippedCount += 1
        console.log(
          `SKIP_SESSION=${sessionId} REASON=CLEANUP_EVIDENCE_MISSING`
        )
        continue
      }

      lock = acquireManagerLock(
        join(LOCKS_ROOT, `action-${sessionId}.lock`),
        {
          owner: 'e3-chat-storage-cleanup',
          acquiredAt: Date.now()
        }
      )

      const databasePath = join(sessionRoot, 'editor.db')
      const databaseStat = lstatSync(databasePath)
      if (
        !databaseStat.isFile() ||
        databaseStat.isSymbolicLink() ||
        databaseStat.uid !== process.getuid() ||
        databaseStat.nlink !== 1 ||
        realpathSync(databasePath) !== resolve(databasePath)
      ) {
        throw new Error('unsafe session editor database')
      }

      database = new Database(databasePath, {
        readonly: true,
        fileMustExist: true
      })

      const result = cleanupTerminalWorkspaceStorage({
        database,
        sessionId,
        sessionRoot,
        workspaceStorageRoot:
          join(sessionRoot, 'workspace-storage'),
        dryRun: !apply
      })

      if (result.alreadyAbsent) {
        alreadyAbsentCount += 1
        console.log(
          `SESSION_STORAGE_ALREADY_ABSENT=${sessionId}`
        )
      } else if (apply && result.removed) {
        removedCount += 1
        reclaimedBytes += result.logicalBytes
        console.log(
          `SESSION_STORAGE_REMOVED=${sessionId} BYTES=${result.logicalBytes}`
        )
      } else if (!apply && result.wouldRemove) {
        console.log(
          `SESSION_STORAGE_WOULD_REMOVE=${sessionId} BYTES=${result.logicalBytes}`
        )
      }
    } catch (error) {
      skippedCount += 1
      console.log(
        `SKIP_SESSION=${sessionId} REASON=${String(error.message).replace(/\s+/g, '_')}`
      )
    } finally {
      database?.close()
      try {
        lock?.release()
      } catch (error) {
        console.log(
          `LOCK_RELEASE_ERROR=${sessionId} REASON=${String(error.message).replace(/\s+/g, '_')}`
        )
      }
    }
  }

  if (apply) {
    console.log('E3_CHAT_STORAGE_CLEANUP_SUCCESS=1')
    console.log(`REMOVED_COUNT=${removedCount}`)
    console.log(
      `ALREADY_ABSENT_COUNT=${alreadyAbsentCount}`
    )
    console.log(`SKIPPED_COUNT=${skippedCount}`)
    console.log(`RECLAIMED_BYTES=${reclaimedBytes}`)
  } else {
    console.log('E3_CHAT_STORAGE_CLEANUP_DRY_RUN=1')
    console.log(
      `ALREADY_ABSENT_COUNT=${alreadyAbsentCount}`
    )
    console.log(`SKIPPED_COUNT=${skippedCount}`)
  }
}

try {
  main()
} catch (error) {
  console.error(`${error.name}: ${error.message}`)
  process.exitCode = 1
}
