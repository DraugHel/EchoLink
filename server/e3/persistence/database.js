import Database from 'better-sqlite3'
import {
  chmodSync,
  mkdirSync
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import {
  E3_PERSISTENCE_ERROR,
  E3PersistenceError
} from './errors.js'
import {
  EDITOR_MIGRATIONS,
  editorMigrationChecksum
} from './migrations/index.js'

export const DEFAULT_EDITOR_DATABASE_PATH =
  '/var/lib/echolink-editor/editor.db'

function persistenceError(code, message, details, cause) {
  return new E3PersistenceError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function validateMigrationSet(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_MIGRATION_SET,
      'Editor migration set must not be empty'
    )
  }

  const versions = new Set()
  const names = new Set()

  migrations.forEach((migration, index) => {
    const expectedVersion = index + 1
    if (
      !migration ||
      migration.version !== expectedVersion ||
      !Number.isSafeInteger(migration.version) ||
      typeof migration.name !== 'string' ||
      migration.name.length === 0 ||
      typeof migration.sql !== 'string' ||
      migration.sql.trim().length === 0 ||
      versions.has(migration.version) ||
      names.has(migration.name)
    ) {
      throw persistenceError(
        E3_PERSISTENCE_ERROR.INVALID_MIGRATION_SET,
        'Editor migrations must be contiguous, unique, and non-empty',
        {
          expectedVersion,
          actualVersion: migration?.version ?? null
        }
      )
    }
    versions.add(migration.version)
    names.add(migration.name)
  })
}

function runExclusive(database, callback) {
  database.exec('BEGIN EXCLUSIVE')
  try {
    const result = callback()
    database.exec('COMMIT')
    return result
  } catch (error) {
    if (database.inTransaction) {
      database.exec('ROLLBACK')
    }
    throw error
  }
}

function ensureMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version >= 1),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL
        CHECK (
          length(checksum) = 64
          AND checksum NOT GLOB '*[^0-9a-f]*'
        ),
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update
    BEFORE UPDATE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'schema_migrations is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'schema_migrations is immutable');
    END
  `)
}

function inspectSchema(database, migrations) {
  ensureMigrationTable(database)

  const applied = database.prepare(`
    SELECT version, name, checksum, applied_at
    FROM schema_migrations
    ORDER BY version
  `).all()
  const latestSupported = migrations.at(-1).version

  for (let index = 0; index < applied.length; index += 1) {
    const row = applied[index]
    const expectedVersion = index + 1
    const migration = migrations[index]

    if (
      row.version !== expectedVersion ||
      !migration ||
      row.version > latestSupported
    ) {
      throw persistenceError(
        E3_PERSISTENCE_ERROR.UNSUPPORTED_SCHEMA,
        'Editor database contains an unsupported migration sequence',
        {
          version: row.version,
          expectedVersion,
          latestSupported
        }
      )
    }

    const expectedChecksum = editorMigrationChecksum(migration)
    if (
      row.name !== migration.name ||
      row.checksum !== expectedChecksum
    ) {
      throw persistenceError(
        E3_PERSISTENCE_ERROR.MIGRATION_CHECKSUM_MISMATCH,
        'Editor migration checksum or name does not match',
        {
          version: row.version,
          expectedName: migration.name,
          actualName: row.name
        }
      )
    }
  }

  const userVersion = database.pragma('user_version', {
    simple: true
  })
  const appliedVersion = applied.at(-1)?.version ?? 0

  if (
    userVersion > latestSupported ||
    userVersion !== appliedVersion
  ) {
    throw persistenceError(
      E3_PERSISTENCE_ERROR.UNSUPPORTED_SCHEMA,
      'Editor database user_version does not match migration history',
      {
        userVersion,
        appliedVersion,
        latestSupported
      }
    )
  }

  return appliedVersion
}

export function migrateEditorDatabase(database, {
  migrations = EDITOR_MIGRATIONS,
  now = Date.now
} = {}) {
  validateMigrationSet(migrations)

  let appliedVersion
  try {
    appliedVersion = runExclusive(
      database,
      () => inspectSchema(database, migrations)
    )

    for (
      let version = appliedVersion + 1;
      version <= migrations.length;
      version += 1
    ) {
      const migration = migrations[version - 1]
      runExclusive(database, () => {
        const currentVersion = inspectSchema(
          database,
          migrations
        )
        if (currentVersion >= migration.version) return
        if (currentVersion !== migration.version - 1) {
          throw persistenceError(
            E3_PERSISTENCE_ERROR.UNSUPPORTED_SCHEMA,
            'Editor migration predecessor is missing',
            {
              version: migration.version,
              currentVersion
            }
          )
        }

        database.exec(migration.sql)
        database.prepare(`
          INSERT INTO schema_migrations (
            version,
            name,
            checksum,
            applied_at
          ) VALUES (?, ?, ?, ?)
        `).run(
          migration.version,
          migration.name,
          editorMigrationChecksum(migration),
          now()
        )
        database.pragma(`user_version = ${migration.version}`)
      })
    }

    return runExclusive(
      database,
      () => inspectSchema(database, migrations)
    )
  } catch (error) {
    if (error instanceof E3PersistenceError) throw error
    throw persistenceError(
      E3_PERSISTENCE_ERROR.MIGRATION_FAILED,
      'Editor database migration failed',
      {},
      error
    )
  }
}

export function configureEditorDatabase(database) {
  try {
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    database.pragma('busy_timeout = 5000')
    database.pragma('synchronous = FULL')

    const actual = {
      journalMode: database.pragma('journal_mode', {
        simple: true
      }),
      foreignKeys: database.pragma('foreign_keys', {
        simple: true
      }),
      busyTimeout: database.pragma('busy_timeout', {
        simple: true
      }),
      synchronous: database.pragma('synchronous', {
        simple: true
      })
    }

    if (
      String(actual.journalMode).toLowerCase() !== 'wal' ||
      actual.foreignKeys !== 1 ||
      actual.busyTimeout !== 5000 ||
      actual.synchronous !== 2
    ) {
      throw persistenceError(
        E3_PERSISTENCE_ERROR.DATABASE_CONFIGURATION_FAILED,
        'Required editor database pragmas could not be established',
        actual
      )
    }
    return Object.freeze(actual)
  } catch (error) {
    if (error instanceof E3PersistenceError) throw error
    throw persistenceError(
      E3_PERSISTENCE_ERROR.DATABASE_CONFIGURATION_FAILED,
      'Failed to configure editor database',
      {},
      error
    )
  }
}

export function verifyEditorDatabase(database) {
  const result = database.pragma('quick_check', {
    simple: true
  })
  if (result !== 'ok') {
    throw persistenceError(
      E3_PERSISTENCE_ERROR.DATABASE_INTEGRITY_FAILED,
      'Editor database quick_check failed',
      { result }
    )
  }
  return true
}

export function openEditorDatabase({
  databasePath = DEFAULT_EDITOR_DATABASE_PATH,
  migrations = EDITOR_MIGRATIONS,
  now = Date.now
} = {}) {
  if (
    typeof databasePath !== 'string' ||
    !isAbsolute(databasePath) ||
    databasePath === ':memory:'
  ) {
    throw persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_DATABASE_PATH,
      'Editor database path must be an absolute file path'
    )
  }

  mkdirSync(dirname(databasePath), {
    recursive: true,
    mode: 0o750
  })

  const database = new Database(databasePath)
  try {
    chmodSync(databasePath, 0o640)
    configureEditorDatabase(database)
    migrateEditorDatabase(database, { migrations, now })
    verifyEditorDatabase(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
