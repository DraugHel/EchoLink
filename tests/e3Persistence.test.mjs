import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  E3_ARTIFACT_TYPE,
  E3_ARTIFACT_TYPES,
  E3DomainError,
  E3_EVENT_TYPES,
  E3_FAILURE_CODE,
  E3_LEASE_RESOURCE_TYPE,
  E3_LEASE_RESOURCE_TYPES,
  E3_OPERATION_TYPE,
  E3_OPERATION_TYPES,
  E3_SESSION_COMMAND,
  E3_SESSION_COMMANDS,
  E3_SESSION_STATUS,
  E3_SESSION_STATUSES,
  E3_VALIDATION_STATUS,
  E3_VALIDATION_STATUSES
} from '../server/e3/core/contracts.js'
import {
  migrateEditorDatabase,
  openEditorDatabase
} from '../server/e3/persistence/database.js'
import {
  EditorRepository
} from '../server/e3/persistence/editorRepository.js'
import {
  E3_PERSISTENCE_ERROR,
  E3PersistenceError
} from '../server/e3/persistence/errors.js'
import {
  INITIAL_SCHEMA_CONTRACTS,
  migration001
} from '../server/e3/persistence/migrations/001-initial-schema.js'
import {
  migration002
} from '../server/e3/persistence/migrations/002-workspaces.js'
import {
  migration003
} from '../server/e3/persistence/migrations/003-operation-intents.js'
import {
  migration004
} from '../server/e3/persistence/migrations/004-candidate-artifacts.js'
import {
  migration005
} from '../server/e3/persistence/migrations/005-review-evidence.js'
import {
  migration006
} from '../server/e3/persistence/migrations/006-approval-records.js'
import {
  migration007
} from '../server/e3/persistence/migrations/007-pilot-exports.js'
import {
  migration008
} from '../server/e3/persistence/migrations/008-recovery-runs.js'
import {
  editorMigrationChecksum
} from '../server/e3/persistence/migrations/index.js'

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_SESSION_ID =
  '123e4567-e89b-42d3-a456-426614174001'
const OPERATION_ID =
  '223e4567-e89b-42d3-a456-426614174000'
const SECOND_OPERATION_ID =
  '223e4567-e89b-42d3-a456-426614174001'
const ARTIFACT_ID =
  '323e4567-e89b-42d3-a456-426614174000'
const VALIDATION_ID =
  '423e4567-e89b-42d3-a456-426614174000'
const BASE_COMMIT = 'a'.repeat(40)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

function expectPersistenceCode(code) {
  return error => (
    error instanceof E3PersistenceError &&
    error.code === code
  )
}

function expectDomainCode(code) {
  return error => (
    error instanceof E3DomainError &&
    error.code === code
  )
}

function createDatabaseHarness(t, options = {}) {
  const directory = mkdtempSync(
    join(tmpdir(), 'echolink-e3-persistence-')
  )
  const databasePath = join(directory, 'editor.db')
  const databases = []

  function open(extra = {}) {
    const database = openEditorDatabase({
      databasePath,
      ...options,
      ...extra
    })
    databases.push(database)
    return database
  }

  t.after(() => {
    for (const database of databases) {
      if (database.open) database.close()
    }
    rmSync(directory, { recursive: true, force: true })
  })

  return { databasePath, open }
}

function createSession(repository, overrides = {}) {
  return repository.createSession({
    id: SESSION_ID,
    baseCommit: BASE_COMMIT,
    createdBy: 'user-1',
    requestSummary: 'Persistente Session',
    createdAt: 1_000,
    leaseOwner: 'control-plane-1',
    leaseExpiresAt: 61_000,
    ...overrides
  })
}

function command(session, type, overrides = {}) {
  return {
    type,
    sessionId: session.id,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: `request-${session.version}-${type}`,
    occurredAt: 2_000 + session.version,
    leaseOwner: 'control-plane-1',
    fencingToken: 1,
    ...overrides
  }
}

function transition(repository, session, type, overrides = {}) {
  return repository.transitionSession(
    command(session, type, overrides)
  )
}

function toEditing(repository, session) {
  session = transition(
    repository,
    session,
    E3_SESSION_COMMAND.START_PROVISIONING
  ).session
  return transition(
    repository,
    session,
    E3_SESSION_COMMAND.FINISH_PROVISIONING
  ).session
}

function toApproved(repository, session) {
  session = toEditing(repository, session)
  session = transition(
    repository,
    session,
    E3_SESSION_COMMAND.START_VALIDATION
  ).session
  session = transition(
    repository,
    session,
    E3_SESSION_COMMAND.MARK_READY_FOR_REVIEW,
    {
      candidate: {
        candidateManifestSha256: HASH_A,
        patchSha256: HASH_B,
        validationManifestSha256: HASH_C,
        pathPolicyVersion: 'paths-v1',
        profileSetVersion: 'profiles-v1'
      }
    }
  ).session
  return transition(
    repository,
    session,
    E3_SESSION_COMMAND.APPROVE,
    {
      binding: {
        sessionId: session.id,
        baseCommit: session.baseCommit,
        ...session.candidate
      }
    }
  ).session
}

test('Migration 001 entspricht den Domänenverträgen', () => {
  assert.deepEqual(
    INITIAL_SCHEMA_CONTRACTS.sessionStatuses,
    E3_SESSION_STATUSES
  )
  assert.deepEqual(
    INITIAL_SCHEMA_CONTRACTS.sessionCommands,
    E3_SESSION_COMMANDS
  )
  assert.deepEqual(
    INITIAL_SCHEMA_CONTRACTS.eventTypes,
    E3_EVENT_TYPES
  )
  assert.deepEqual(
    INITIAL_SCHEMA_CONTRACTS.operationTypes,
    E3_OPERATION_TYPES
  )
  assert.deepEqual(
    INITIAL_SCHEMA_CONTRACTS.artifactTypes,
    E3_ARTIFACT_TYPES
  )
  assert.deepEqual(
    INITIAL_SCHEMA_CONTRACTS.validationStatuses,
    E3_VALIDATION_STATUSES
  )
  assert.deepEqual(
    INITIAL_SCHEMA_CONTRACTS.leaseResourceTypes,
    E3_LEASE_RESOURCE_TYPES
  )
})

test('editor.db erzwingt Pragmas, Schema und Migrationchecksum', t => {
  const harness = createDatabaseHarness(t, {
    now: () => 1_700
  })
  const database = harness.open()

  assert.equal(
    database.pragma('journal_mode', { simple: true }),
    'wal'
  )
  assert.equal(
    database.pragma('foreign_keys', { simple: true }),
    1
  )
  assert.equal(
    database.pragma('busy_timeout', { simple: true }),
    5000
  )
  assert.equal(
    database.pragma('synchronous', { simple: true }),
    2
  )
  assert.equal(
    database.pragma('quick_check', { simple: true }),
    'ok'
  )

  const migrations = database.prepare(`
    SELECT version, name, checksum, applied_at
    FROM schema_migrations
    ORDER BY version
  `).all()
  assert.deepEqual(migrations, [
    {
      version: 1,
      name: migration001.name,
      checksum: editorMigrationChecksum(migration001),
      applied_at: 1_700
    },
    {
      version: 2,
      name: migration002.name,
      checksum: editorMigrationChecksum(migration002),
      applied_at: 1_700
    },
    {
      version: 3,
      name: migration003.name,
      checksum: editorMigrationChecksum(migration003),
      applied_at: 1_700
    },
    {
      version: 4,
      name: migration004.name,
      checksum: editorMigrationChecksum(migration004),
      applied_at: 1_700
    },
    {
      version: 5,
      name: migration005.name,
      checksum: editorMigrationChecksum(migration005),
      applied_at: 1_700
    },
    {
      version: 6,
      name: migration006.name,
      checksum: editorMigrationChecksum(migration006),
      applied_at: 1_700
    },
    {
      version: 7,
      name: migration007.name,
      checksum: editorMigrationChecksum(migration007),
      applied_at: 1_700
    },
    {
      version: 8,
      name: migration008.name,
      checksum: editorMigrationChecksum(migration008),
      applied_at: 1_700
    }
  ])
  assert.equal(database.pragma('user_version', {
    simple: true
  }), 8)

  const tables = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'editor_%'
    ORDER BY name
  `).all().map(row => row.name)
  assert.deepEqual(tables, [
    'editor_approval_records',
    'editor_artifacts',
    'editor_candidate_artifact_sets',
    'editor_events',
    'editor_idempotency_keys',
    'editor_leases',
    'editor_operation_intents',
    'editor_operation_preimages',
    'editor_operations',
    'editor_pilot_export_records',
    'editor_recovery_decisions',
    'editor_recovery_runs',
    'editor_review_sets',
    'editor_sessions',
    'editor_validation_evidence',
    'editor_validation_runs',
    'editor_workspaces'
  ])
})

test('Migration rollbackt vollständig bei einem Teilfehler', t => {
  const directory = mkdtempSync(
    join(tmpdir(), 'echolink-e3-migration-')
  )
  const databasePath = join(directory, 'editor.db')
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const brokenMigration = Object.freeze({
    version: 9,
    name: 'broken_test_migration',
    sql: `
      CREATE TABLE migration_must_rollback (id INTEGER);
      INSERT INTO table_that_does_not_exist VALUES (1);
    `
  })

  assert.throws(
    () => openEditorDatabase({
      databasePath,
      migrations: [
        migration001,
        migration002,
        migration003,
        migration004,
        migration005,
        migration006,
        migration007,
        migration008,
        brokenMigration
      ],
      now: () => 2_000
    }),
    expectPersistenceCode(E3_PERSISTENCE_ERROR.MIGRATION_FAILED)
  )

  const database = new Database(databasePath)
  t.after(() => database.close())
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM schema_migrations
    `).get().count,
    8
  )
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE name = 'migration_must_rollback'
    `).get().count,
    0
  )
  assert.equal(database.pragma('user_version', {
    simple: true
  }), 8)
})

test('Bestehende Schema-Version 1 wird additiv auf 8 migriert', t => {
  const directory = mkdtempSync(
    join(tmpdir(), 'echolink-e3-v1-upgrade-')
  )
  const databasePath = join(directory, 'editor.db')
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const versionOne = openEditorDatabase({
    databasePath,
    migrations: [migration001],
    now: () => 1_000
  })
  assert.equal(versionOne.pragma('user_version', {
    simple: true
  }), 1)
  versionOne.close()

  const upgraded = openEditorDatabase({
    databasePath,
    now: () => 2_000
  })
  t.after(() => upgraded.close())
  assert.equal(upgraded.pragma('user_version', {
    simple: true
  }), 8)
  assert.deepEqual(
    upgraded.prepare(`
      SELECT version, name
      FROM schema_migrations
      ORDER BY version
    `).all(),
    [
      {
        version: 1,
        name: migration001.name
      },
      {
        version: 2,
        name: migration002.name
      },
      {
        version: 3,
        name: migration003.name
      },
      {
        version: 4,
        name: migration004.name
      },
      {
        version: 5,
        name: migration005.name
      },
      {
        version: 6,
        name: migration006.name
      },
      {
        version: 7,
        name: migration007.name
      },
      {
        version: 8,
        name: migration008.name
      }
    ]
  )
  assert.equal(
    upgraded.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'editor_workspaces'
    `).get().count,
    1
  )
})

test('Unbekannte oder manipulierte Migration stoppt den Start', t => {
  const checksumHarness = createDatabaseHarness(t)
  const checksumDatabase = checksumHarness.open()
  assert.throws(
    () => checksumDatabase.prepare(`
      UPDATE schema_migrations
      SET checksum = ?
      WHERE version = 1
    `).run('b'.repeat(64)),
    /immutable/
  )
  checksumDatabase.exec(`
    DROP TRIGGER schema_migrations_no_update
  `)
  checksumDatabase.prepare(`
    UPDATE schema_migrations
    SET checksum = ?
    WHERE version = 1
  `).run('b'.repeat(64))
  checksumDatabase.close()

  assert.throws(
    () => checksumHarness.open(),
    expectPersistenceCode(
      E3_PERSISTENCE_ERROR.MIGRATION_CHECKSUM_MISMATCH
    )
  )

  const versionDirectory = mkdtempSync(
    join(tmpdir(), 'echolink-e3-schema-version-')
  )
  const versionPath = join(versionDirectory, 'editor.db')
  t.after(() => {
    rmSync(versionDirectory, { recursive: true, force: true })
  })
  const versionDatabase = openEditorDatabase({
    databasePath: versionPath
  })
  versionDatabase.pragma('user_version = 99')
  versionDatabase.close()
  assert.throws(
    () => openEditorDatabase({ databasePath: versionPath }),
    expectPersistenceCode(
      E3_PERSISTENCE_ERROR.UNSUPPORTED_SCHEMA
    )
  )
})

test('Session, Erstellungsereignis und Lease committen atomar', t => {
  const harness = createDatabaseHarness(t)
  const database = harness.open()
  const repository = new EditorRepository(database, {
    faultInjector(point) {
      if (point === 'create.after_session') {
        throw new Error('injected create failure')
      }
    }
  })

  assert.throws(
    () => createSession(repository),
    /injected create failure/
  )
  for (const table of [
    'editor_sessions',
    'editor_events',
    'editor_leases'
  ]) {
    assert.equal(
      database.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`
      ).get().count,
      0
    )
  }
})

test('Transition und Event rollbacken gemeinsam bei Teilfehler', t => {
  const harness = createDatabaseHarness(t)
  const database = harness.open()
  const setupRepository = new EditorRepository(database)
  const session = createSession(setupRepository).session
  const repository = new EditorRepository(database, {
    faultInjector(point) {
      if (point === 'transition.after_session_update') {
        throw new Error('injected transition failure')
      }
    }
  })

  assert.throws(
    () => transition(
      repository,
      session,
      E3_SESSION_COMMAND.START_PROVISIONING
    ),
    /injected transition failure/
  )
  assert.equal(repository.getSession(SESSION_ID).version, 0)
  assert.equal(
    repository.getSession(SESSION_ID).status,
    E3_SESSION_STATUS.CREATED
  )
  assert.equal(repository.listEvents(SESSION_ID).length, 1)
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM editor_idempotency_keys
    `).get().count,
    0
  )
})

test('Request-ID-Replay ist exakt einmal und payloadgebunden', t => {
  const harness = createDatabaseHarness(t)
  const repository = new EditorRepository(harness.open())
  const session = createSession(repository).session
  const firstCommand = command(
    session,
    E3_SESSION_COMMAND.START_PROVISIONING
  )
  const first = repository.transitionSession(firstCommand)
  const replay = repository.transitionSession(firstCommand)

  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.session.version, first.session.version)
  assert.equal(replay.event.id, first.event.id)
  assert.equal(repository.listEvents(SESSION_ID).length, 2)

  assert.throws(
    () => repository.transitionSession({
      ...firstCommand,
      actorId: 'other-user'
    }),
    expectPersistenceCode(
      E3_PERSISTENCE_ERROR.IDEMPOTENCY_CONFLICT
    )
  )
})

test('Zwei Verbindungen können dieselbe Version nicht überschreiben', t => {
  const harness = createDatabaseHarness(t)
  const firstRepository = new EditorRepository(harness.open())
  const secondRepository = new EditorRepository(harness.open())
  const session = createSession(firstRepository).session

  firstRepository.transitionSession(
    command(
      session,
      E3_SESSION_COMMAND.START_PROVISIONING,
      { requestId: 'writer-one-request' }
    )
  )

  assert.throws(
    () => secondRepository.transitionSession(
      command(
        session,
        E3_SESSION_COMMAND.START_PROVISIONING,
        { requestId: 'writer-two-request' }
      )
    ),
    expectDomainCode(E3_FAILURE_CODE.STALE_VERSION)
  )
  assert.equal(
    secondRepository.getSession(SESSION_ID).version,
    1
  )
  assert.equal(
    secondRepository.listEvents(SESSION_ID).length,
    2
  )
})

test('Session, Events und Lease überleben einen Neustart', t => {
  const harness = createDatabaseHarness(t)
  const firstDatabase = harness.open()
  const firstRepository = new EditorRepository(firstDatabase)
  let session = createSession(firstRepository).session
  session = transition(
    firstRepository,
    session,
    E3_SESSION_COMMAND.START_PROVISIONING
  ).session
  firstDatabase.close()

  const secondDatabase = harness.open()
  const secondRepository = new EditorRepository(secondDatabase)
  assert.equal(
    secondRepository.getSession(SESSION_ID).status,
    E3_SESSION_STATUS.PROVISIONING
  )
  assert.equal(secondRepository.listEvents(SESSION_ID).length, 2)
  assert.deepEqual(
    secondRepository.getLease(
      E3_LEASE_RESOURCE_TYPE.SESSION,
      SESSION_ID
    ),
    {
      resourceType: E3_LEASE_RESOURCE_TYPE.SESSION,
      resourceKey: SESSION_ID,
      owner: 'control-plane-1',
      acquiredAt: 1_000,
      heartbeatAt: 1_000,
      expiresAt: 61_000,
      fencingToken: 1
    }
  )
})

test('Operation und Kandidateninvalidierung committen atomar', t => {
  const harness = createDatabaseHarness(t)
  const database = harness.open()
  const repository = new EditorRepository(database)
  let session = createSession(repository).session
  session = toApproved(repository, session)

  const mutation = command(
    session,
    E3_SESSION_COMMAND.RECORD_MUTATION,
    { requestId: 'mutation-request-one' }
  )
  const result = repository.recordOperation(mutation, {
    id: OPERATION_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    type: E3_OPERATION_TYPE.REPLACE_EXACT,
    pathBefore: 'server/example.js',
    pathAfter: 'server/example.js',
    preimageSha256: HASH_A,
    postimageSha256: HASH_B,
    parameters: {
      expectedOccurrences: 1
    }
  })

  assert.equal(result.session.status, E3_SESSION_STATUS.EDITING)
  assert.equal(result.session.candidate, null)
  assert.equal(result.session.approval, null)
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM editor_operations
    `).get().count,
    1
  )
  const replay = repository.recordOperation(mutation, {
    id: OPERATION_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    type: E3_OPERATION_TYPE.REPLACE_EXACT,
    pathBefore: 'server/example.js',
    pathAfter: 'server/example.js',
    preimageSha256: HASH_A,
    postimageSha256: HASH_B,
    parameters: {
      expectedOccurrences: 1
    }
  })
  assert.equal(replay.replayed, true)
  assert.throws(
    () => repository.recordOperation(mutation, {
      id: OPERATION_ID,
      sessionId: SESSION_ID,
      sequence: 1,
      type: E3_OPERATION_TYPE.REPLACE_EXACT,
      pathBefore: 'server/example.js',
      pathAfter: 'server/example.js',
      preimageSha256: HASH_A,
      postimageSha256: HASH_C,
      parameters: {
        expectedOccurrences: 1
      }
    }),
    expectPersistenceCode(
      E3_PERSISTENCE_ERROR.IDEMPOTENCY_CONFLICT
    )
  )

  const duplicateSequence = command(
    result.session,
    E3_SESSION_COMMAND.RECORD_MUTATION,
    { requestId: 'mutation-request-two' }
  )
  assert.throws(
    () => repository.recordOperation(
      duplicateSequence,
      {
        id: SECOND_OPERATION_ID,
        sessionId: SESSION_ID,
        sequence: 1,
        type: E3_OPERATION_TYPE.DELETE_FILE,
        pathBefore: 'server/old.js',
        pathAfter: null,
        preimageSha256: HASH_C,
        postimageSha256: null,
        parameters: {}
      }
    ),
    expectPersistenceCode(E3_PERSISTENCE_ERROR.INVALID_RECORD)
  )
  assert.equal(
    repository.getSession(SESSION_ID).version,
    result.session.version
  )
  assert.equal(
    repository.listEvents(SESSION_ID).length,
    result.session.version + 1
  )
})

test('Events sind append-only und Fremdschlüssel fail-closed', t => {
  const harness = createDatabaseHarness(t)
  const database = harness.open()
  const repository = new EditorRepository(database)
  createSession(repository)

  assert.throws(
    () => database.prepare(`
      UPDATE editor_events SET actor_id = 'tampered'
    `).run(),
    /append-only/
  )
  assert.throws(
    () => database.prepare(`
      DELETE FROM editor_events
    `).run(),
    /append-only/
  )
  assert.throws(() => repository.recordArtifact({
    id: ARTIFACT_ID,
    sessionId: OTHER_SESSION_ID,
    type: E3_ARTIFACT_TYPE.UNIFIED_DIFF,
    storageKey: 'sessions/missing/diff',
    sha256: HASH_A,
    sizeBytes: 100,
    retentionClass: 'standard',
    createdAt: 3_000
  }), /FOREIGN KEY constraint failed/)
})

test('Artefakt- und Validierungsmetadaten werden typisiert gespeichert', t => {
  const harness = createDatabaseHarness(t)
  const database = harness.open()
  const repository = new EditorRepository(database)
  createSession(repository)

  const artifact = repository.recordArtifact({
    id: ARTIFACT_ID,
    sessionId: SESSION_ID,
    type: E3_ARTIFACT_TYPE.VALIDATION_LOG,
    storageKey: 'sessions/123/validation.log',
    sha256: HASH_A,
    sizeBytes: 123,
    retentionClass: 'standard',
    createdAt: 3_000
  })
  const validation = repository.createValidationRun({
    id: VALIDATION_ID,
    sessionId: SESSION_ID,
    profile: 'node-v1',
    status: E3_VALIDATION_STATUS.QUEUED,
    candidateSha256: HASH_B,
    timeoutMs: 60_000,
    createdAt: 3_100
  })

  assert.equal(artifact.type, 'validation_log')
  assert.equal(validation.status, 'QUEUED')
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM editor_artifacts
    `).get().count,
    1
  )
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM editor_validation_runs
    `).get().count,
    1
  )
})

test('Lease-Claim erhöht Fencing und Ablauf allein erlaubt kein Takeover', t => {
  const harness = createDatabaseHarness(t)
  const repository = new EditorRepository(harness.open())
  const session = createSession(repository).session

  const renewedClaim = repository.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.SESSION,
    resourceKey: SESSION_ID,
    owner: 'control-plane-1',
    occurredAt: 70_000,
    expiresAt: 130_000,
    expectedFencingToken: 1
  })
  assert.equal(renewedClaim.fencingToken, 2)

  assert.throws(
    () => repository.transitionSession(
      command(
        session,
        E3_SESSION_COMMAND.START_PROVISIONING
      )
    ),
    expectDomainCode(E3_FAILURE_CODE.STALE_FENCING_TOKEN)
  )
  assert.throws(
    () => repository.claimLease({
      resourceType: E3_LEASE_RESOURCE_TYPE.SESSION,
      resourceKey: SESSION_ID,
      owner: 'control-plane-2',
      occurredAt: 140_000,
      expiresAt: 200_000,
      expectedFencingToken: 2
    }),
    expectPersistenceCode(E3_PERSISTENCE_ERROR.LEASE_CONFLICT)
  )

  const takeover = repository.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.SESSION,
    resourceKey: SESSION_ID,
    owner: 'control-plane-2',
    occurredAt: 140_000,
    expiresAt: 200_000,
    expectedFencingToken: 2,
    previousOwnerConfirmedDead: true
  })
  assert.equal(takeover.owner, 'control-plane-2')
  assert.equal(takeover.fencingToken, 3)
})

test('Migrationset akzeptiert keine Lücken', t => {
  const harness = createDatabaseHarness(t)
  const database = harness.open()
  const invalid = Object.freeze({
    version: 10,
    name: 'skipped_version',
    sql: 'CREATE TABLE skipped_version (id INTEGER) STRICT;'
  })

  assert.throws(
    () => migrateEditorDatabase(database, {
      migrations: [
        migration001,
        migration002,
        migration003,
        migration004,
        migration005,
        migration006,
        migration007,
        migration008,
        invalid
      ]
    }),
    expectPersistenceCode(
      E3_PERSISTENCE_ERROR.INVALID_MIGRATION_SET
    )
  )
})
