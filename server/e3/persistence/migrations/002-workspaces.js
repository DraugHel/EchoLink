const WORKSPACE_STATES = Object.freeze([
  'PROVISIONING',
  'READY',
  'REMOVING',
  'REMOVED',
  'QUARANTINED'
])

function sqlList(values) {
  return values.map(value => `'${value}'`).join(', ')
}

export const WORKSPACE_SCHEMA_CONTRACTS = Object.freeze({
  workspaceStates: WORKSPACE_STATES
})

export const migration002 = Object.freeze({
  version: 2,
  name: 'workspace_metadata',
  sql: `
CREATE TABLE editor_workspaces (
  session_id TEXT PRIMARY KEY
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  workspace_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL
    CHECK (state IN (${sqlList(WORKSPACE_STATES)})),
  base_commit TEXT NOT NULL
    CHECK (
      length(base_commit) = 40
      AND base_commit NOT GLOB '*[^0-9a-f]*'
    ),
  tree_sha TEXT NOT NULL
    CHECK (
      length(tree_sha) = 40
      AND tree_sha NOT GLOB '*[^0-9a-f]*'
    ),
  canonical_path TEXT NOT NULL UNIQUE,
  manifest_sha256 TEXT NOT NULL
    CHECK (
      length(manifest_sha256) = 64
      AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  manager_owner TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= created_at),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  logical_size_bytes INTEGER NOT NULL
    CHECK (logical_size_bytes >= 0),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  symlink_count INTEGER NOT NULL CHECK (symlink_count >= 0),
  removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= created_at),
  CHECK (
    (state = 'REMOVED' AND removed_at IS NOT NULL)
    OR (state <> 'REMOVED' AND removed_at IS NULL)
  )
) STRICT;

CREATE INDEX editor_workspaces_state_heartbeat_idx
ON editor_workspaces(state, heartbeat_at);

CREATE TRIGGER editor_workspaces_identity_immutable
BEFORE UPDATE OF
  session_id,
  workspace_key,
  base_commit,
  tree_sha,
  canonical_path,
  manifest_sha256,
  manager_owner,
  created_at
ON editor_workspaces
BEGIN
  SELECT RAISE(ABORT, 'editor workspace identity is immutable');
END;
`
})
