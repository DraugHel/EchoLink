const STATES = [
  'PREPARED',
  'PUBLISHED',
  'RECORDED',
  'RECOVERY_REQUIRED'
]
const TYPES = [
  'create_file',
  'replace_exact',
  'insert_before',
  'insert_after',
  'rename_file',
  'move_file',
  'delete_file'
]
const sqlList = values => values.map(value => `'${value}'`).join(', ')

export const migration003 = Object.freeze({
  version: 3,
  name: 'operation_intents',
  sql: `
CREATE TABLE editor_operation_intents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  state TEXT NOT NULL CHECK (state IN (${sqlList(STATES)})),
  operation_type TEXT NOT NULL CHECK (operation_type IN (${sqlList(TYPES)})),
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  request_metadata_json TEXT NOT NULL CHECK (json_valid(request_metadata_json)),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  path_before TEXT,
  path_after TEXT,
  preimage_sha256 TEXT CHECK (preimage_sha256 IS NULL OR length(preimage_sha256) = 64),
  postimage_sha256 TEXT CHECK (postimage_sha256 IS NULL OR length(postimage_sha256) = 64),
  changed_bytes INTEGER NOT NULL CHECK (changed_bytes >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  session_owner TEXT NOT NULL,
  session_fencing_token INTEGER NOT NULL CHECK (session_fencing_token >= 1),
  workspace_owner TEXT NOT NULL,
  workspace_fencing_token INTEGER NOT NULL CHECK (workspace_fencing_token >= 1),
  workspace_path TEXT NOT NULL,
  prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
  published_at INTEGER,
  recorded_at INTEGER,
  recovery_reason TEXT,
  UNIQUE (session_id, request_id),
  UNIQUE (session_id, sequence)
) STRICT;

CREATE UNIQUE INDEX editor_operation_intents_one_active
ON editor_operation_intents(session_id)
WHERE state IN ('PREPARED', 'PUBLISHED', 'RECOVERY_REQUIRED');

CREATE TABLE editor_operation_preimages (
  intent_id TEXT NOT NULL REFERENCES editor_operation_intents(id) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  storage_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (intent_id, sha256)
) STRICT;
`
})
