# ADR-004: Metadata database and artifact store

- **Status:** accepted
- **Date:** 2026-07-27
- **Scope:** E3 V1

## Context

E3 needs transactional session state and immutable potentially large diffs,
logs, screenshots, manifests, and file preimages. Adding ad hoc boot migrations
to the existing application database would couple E3 recovery to unrelated
tables. Storing large blobs inside SQLite would make backups, retention, and
integrity checks expensive.

## Decision

E3 uses a separate SQLite database named `editor.db` plus a manager-owned
content-addressed artifact store.

### Database location and connection policy

Default:

```text
/var/lib/echolink-editor/editor.db
```

Every connection explicitly configures and verifies:

- `journal_mode = WAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`
- `synchronous = FULL`

Startup fails closed if required pragmas cannot be established or if the
schema version is unsupported. A read-only health mode may report the problem
without mutating sessions.

### Migrations

- numbered, immutable migration files
- one `schema_migrations` row per applied version with checksum and timestamp
- exclusive migration lock
- transaction per migration where SQLite permits
- startup never guesses that an error means “already migrated”
- down migrations are not automatic; restore uses a verified backup
- migration tests start from empty DB and each supported prior version

### Core records

The schema contains:

- `editor_sessions`
- `editor_operations`
- `editor_events`
- `editor_validation_runs`
- `editor_artifacts`
- `editor_leases`
- `editor_idempotency_keys`

Session status, event type, operation type, and artifact type constraints must
be checked against the domain definitions in tests.

All stored timestamps are UTC Unix milliseconds. Durations and timeouts are
stored separately. Lease expiry is never the sole proof that takeover or
cleanup is safe.

### Transaction boundaries

- state transition and append-only event commit together
- operation sequence, pre/post hashes, and candidate invalidation commit
  together
- approval and its complete hash binding commit together
- lease claim increments the fencing token in the same transaction
- an artifact DB row is published only after durable bytes and checksum exist

### Artifact store

Artifacts are immutable and addressed by SHA-256:

```text
artifacts/objects/sha256/<first-two>/<remaining-hash>
artifacts/sessions/<session-id>/<logical-manifest>
```

Publishing an artifact:

1. streams to a manager-created temporary file with a strict byte limit
2. computes SHA-256 while writing
3. flushes and fsyncs the file
4. atomically renames it inside the same filesystem
5. fsyncs the parent directory
6. inserts metadata in SQLite

Existing objects are reused only after size and hash verification. Session
manifests refer to objects; they are not user-controlled filesystem paths.

### Artifact classes

- candidate manifest
- forward and reverse patch
- unified diff and diff stat
- validation manifest
- bounded stdout/stderr log
- screenshot
- structured review summary
- export package
- future apply journal and preimage

Secrets, production database copies, credential files, and unrestricted core
dumps are never artifact classes.

## Backup and integrity

- use SQLite's online backup API
- verify backup with `integrity_check`
- back up schema checksum and artifact manifest together
- startup runs `quick_check`; scheduled maintenance runs `integrity_check`
- missing, oversized, or hash-mismatched objects quarantine the affected
  session and prevent review/export

## Consequences

- E3 schema evolution is isolated from the application database.
- State remains transactional while large bytes remain manageable.
- Durability requires careful fsync and DB/file publication ordering.
- Artifact garbage collection must understand references and pins.

## Rejected alternatives

- add E3 tables through scattered `try/catch ALTER TABLE`
- store large logs and screenshots as SQLite blobs
- mutable artifacts addressed by path
- write artifact metadata before bytes are durable
- continue startup after an unknown migration checksum

## Verification

- pragma and foreign-key tests use real SQLite connections
- all migration paths and checksum mismatches are tested
- crash injection covers temp write, fsync, rename, DB insert, and event commit
- artifact tampering blocks review and export
- concurrent publication of identical content remains correct
- backup restore validates DB plus referenced objects
