const SESSION_STATUSES = Object.freeze([
  'CREATED',
  'PROVISIONING',
  'EDITING',
  'VALIDATING',
  'READY_FOR_REVIEW',
  'APPROVED',
  'EXPORTING',
  'EXPORTED',
  'COMPLETED',
  'RECOVERING',
  'FAILED',
  'CANCELLED',
  'STALE',
  'CONFLICTED',
  'APPLYING',
  'APPLIED',
  'FINAL_VERIFYING',
  'REVERTING',
  'REVERTED'
])

const SESSION_COMMANDS = Object.freeze([
  'START_PROVISIONING',
  'FINISH_PROVISIONING',
  'RECORD_MUTATION',
  'START_VALIDATION',
  'RECORD_VALIDATION_FAILURE',
  'MARK_READY_FOR_REVIEW',
  'REOPEN_FOR_EDITING',
  'APPROVE',
  'START_EXPORT',
  'FINISH_EXPORT',
  'COMPLETE',
  'FAIL',
  'CANCEL',
  'MARK_STALE',
  'START_RECOVERY',
  'FINISH_RECOVERY',
  'MARK_CONFLICTED',
  'START_APPLY',
  'START_REVERT'
])

const EVENT_TYPES = Object.freeze([
  'SESSION_CREATED',
  'PROVISIONING_STARTED',
  'PROVISIONING_FINISHED',
  'MUTATION_RECORDED',
  'VALIDATION_STARTED',
  'VALIDATION_FAILED',
  'REVIEW_READY',
  'REVIEW_REOPENED',
  'SESSION_APPROVED',
  'EXPORT_STARTED',
  'EXPORT_FINISHED',
  'SESSION_COMPLETED',
  'SESSION_FAILED',
  'SESSION_CANCELLED',
  'SESSION_STALE',
  'RECOVERY_STARTED',
  'RECOVERY_FINISHED',
  'SESSION_CONFLICTED'
])

const OPERATION_TYPES = Object.freeze([
  'create_file',
  'replace_exact',
  'insert_before',
  'insert_after',
  'rename_file',
  'move_file',
  'delete_file'
])

const ARTIFACT_TYPES = Object.freeze([
  'candidate_manifest',
  'forward_patch',
  'reverse_patch',
  'unified_diff',
  'diff_stat',
  'validation_manifest',
  'validation_log',
  'screenshot',
  'review_summary',
  'export_package'
])

const VALIDATION_STATUSES = Object.freeze([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT'
])

const LEASE_RESOURCE_TYPES = Object.freeze([
  'session',
  'workspace',
  'mirror_update',
  'validation_run',
  'port',
  'cleanup',
  'apply'
])

function sqlList(values) {
  return values.map(value => `'${value}'`).join(', ')
}

const sessionStatuses = sqlList(SESSION_STATUSES)
const sessionCommands = sqlList(SESSION_COMMANDS)
const eventTypes = sqlList(EVENT_TYPES)
const operationTypes = sqlList(OPERATION_TYPES)
const artifactTypes = sqlList(ARTIFACT_TYPES)
const validationStatuses = sqlList(VALIDATION_STATUSES)
const leaseResourceTypes = sqlList(LEASE_RESOURCE_TYPES)

export const INITIAL_SCHEMA_CONTRACTS = Object.freeze({
  sessionStatuses: SESSION_STATUSES,
  sessionCommands: SESSION_COMMANDS,
  eventTypes: EVENT_TYPES,
  operationTypes: OPERATION_TYPES,
  artifactTypes: ARTIFACT_TYPES,
  validationStatuses: VALIDATION_STATUSES,
  leaseResourceTypes: LEASE_RESOURCE_TYPES
})

export const migration001 = Object.freeze({
  version: 1,
  name: 'initial_editor_schema',
  sql: `
CREATE TABLE editor_sessions (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36
      AND id = lower(id)
      AND substr(id, 9, 1) = '-'
      AND substr(id, 14, 1) = '-'
      AND substr(id, 19, 1) = '-'
      AND substr(id, 24, 1) = '-'
      AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  status TEXT NOT NULL CHECK (status IN (${sessionStatuses})),
  base_commit TEXT NOT NULL
    CHECK (
      length(base_commit) = 40
      AND base_commit NOT GLOB '*[^0-9a-f]*'
    ),
  request_summary TEXT NOT NULL DEFAULT ''
    CHECK (length(request_summary) <= 2000),
  semantic_summary TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  heartbeat_at INTEGER CHECK (heartbeat_at IS NULL OR heartbeat_at >= 0),
  workspace_key TEXT,
  candidate_manifest_sha256 TEXT
    CHECK (
      candidate_manifest_sha256 IS NULL
      OR (
        length(candidate_manifest_sha256) = 64
        AND candidate_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  patch_sha256 TEXT
    CHECK (
      patch_sha256 IS NULL
      OR (
        length(patch_sha256) = 64
        AND patch_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  validation_manifest_sha256 TEXT
    CHECK (
      validation_manifest_sha256 IS NULL
      OR (
        length(validation_manifest_sha256) = 64
        AND validation_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  path_policy_version TEXT,
  profile_set_version TEXT,
  review_ready_at INTEGER
    CHECK (review_ready_at IS NULL OR review_ready_at >= 0),
  approved_by TEXT,
  approved_at INTEGER CHECK (approved_at IS NULL OR approved_at >= 0),
  export_sha256 TEXT
    CHECK (
      export_sha256 IS NULL
      OR (
        length(export_sha256) = 64
        AND export_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  exported_at INTEGER CHECK (exported_at IS NULL OR exported_at >= 0),
  failure_code TEXT,
  failure_message TEXT,
  failed_at INTEGER CHECK (failed_at IS NULL OR failed_at >= 0),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK (
    (
      candidate_manifest_sha256 IS NULL
      AND patch_sha256 IS NULL
      AND validation_manifest_sha256 IS NULL
      AND path_policy_version IS NULL
      AND profile_set_version IS NULL
    )
    OR (
      candidate_manifest_sha256 IS NOT NULL
      AND patch_sha256 IS NOT NULL
      AND validation_manifest_sha256 IS NOT NULL
      AND path_policy_version IS NOT NULL
      AND profile_set_version IS NOT NULL
    )
  ),
  CHECK (
    (approved_by IS NULL AND approved_at IS NULL)
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CHECK (
    (export_sha256 IS NULL AND exported_at IS NULL)
    OR (export_sha256 IS NOT NULL AND exported_at IS NOT NULL)
  ),
  CHECK (
    (
      failure_code IS NULL
      AND failure_message IS NULL
      AND failed_at IS NULL
    )
    OR (
      failure_code IS NOT NULL
      AND failure_message IS NOT NULL
      AND failed_at IS NOT NULL
    )
  )
) STRICT;

CREATE TABLE editor_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  operation_type TEXT NOT NULL CHECK (operation_type IN (${operationTypes})),
  path_before TEXT,
  path_after TEXT,
  preimage_sha256 TEXT
    CHECK (
      preimage_sha256 IS NULL
      OR (
        length(preimage_sha256) = 64
        AND preimage_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  postimage_sha256 TEXT
    CHECK (
      postimage_sha256 IS NULL
      OR (
        length(postimage_sha256) = 64
        AND postimage_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, request_id)
) STRICT;

CREATE TABLE editor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN (${eventTypes})),
  from_status TEXT
    CHECK (from_status IS NULL OR from_status IN (${sessionStatuses})),
  to_status TEXT NOT NULL CHECK (to_status IN (${sessionStatuses})),
  actor_id TEXT NOT NULL,
  request_id TEXT,
  version_before INTEGER
    CHECK (version_before IS NULL OR version_before >= 0),
  version_after INTEGER NOT NULL CHECK (version_after >= 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (session_id, sequence)
) STRICT;

CREATE UNIQUE INDEX editor_events_request_id_unique
ON editor_events(session_id, request_id)
WHERE request_id IS NOT NULL;

CREATE TRIGGER editor_events_no_update
BEFORE UPDATE ON editor_events
BEGIN
  SELECT RAISE(ABORT, 'editor_events is append-only');
END;

CREATE TRIGGER editor_events_no_delete
BEFORE DELETE ON editor_events
BEGIN
  SELECT RAISE(ABORT, 'editor_events is append-only');
END;

CREATE TABLE editor_validation_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  profile TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${validationStatuses})),
  candidate_sha256 TEXT NOT NULL
    CHECK (
      length(candidate_sha256) = 64
      AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= 0),
  exit_code INTEGER,
  failure_code TEXT,
  log_artifact_id TEXT
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  fencing_token INTEGER CHECK (fencing_token IS NULL OR fencing_token >= 1)
) STRICT;

CREATE TABLE editor_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (${artifactTypes})),
  storage_key TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 512),
  sha256 TEXT NOT NULL
    CHECK (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  retention_class TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  UNIQUE (session_id, artifact_type, storage_key)
) STRICT;

CREATE TABLE editor_leases (
  resource_type TEXT NOT NULL CHECK (resource_type IN (${leaseResourceTypes})),
  resource_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
  heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= acquired_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > heartbeat_at),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  PRIMARY KEY (resource_type, resource_key)
) STRICT;

CREATE TABLE editor_idempotency_keys (
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (command_type IN (${sessionCommands})),
  command_sha256 TEXT NOT NULL
    CHECK (
      length(command_sha256) = 64
      AND command_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  result_version INTEGER NOT NULL CHECK (result_version >= 0),
  event_id INTEGER NOT NULL UNIQUE
    REFERENCES editor_events(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (session_id, request_id)
) STRICT;

CREATE INDEX editor_sessions_status_updated_idx
ON editor_sessions(status, updated_at);

CREATE INDEX editor_operations_session_idx
ON editor_operations(session_id, sequence);

CREATE INDEX editor_events_session_idx
ON editor_events(session_id, sequence);

CREATE INDEX editor_validation_runs_session_idx
ON editor_validation_runs(session_id, created_at);

CREATE INDEX editor_artifacts_session_idx
ON editor_artifacts(session_id, created_at);
`
})
