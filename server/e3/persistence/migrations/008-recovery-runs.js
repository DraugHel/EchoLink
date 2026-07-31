export const migration008 = Object.freeze({
  version: 8,
  name: 'recovery_reaper_audit',
  sql: `
CREATE TABLE editor_recovery_runs (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36
      AND id = lower(id)
      AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  policy_version TEXT NOT NULL CHECK (length(policy_version) >= 1),
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
  storage_root_sha256 TEXT NOT NULL CHECK (length(storage_root_sha256) = 64),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 8 AND 160),
  cleanup_lease_owner TEXT NOT NULL CHECK (length(cleanup_lease_owner) BETWEEN 1 AND 160),
  cleanup_fencing_token INTEGER NOT NULL CHECK (cleanup_fencing_token >= 1),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  completed_at INTEGER NOT NULL CHECK (completed_at >= started_at),
  decision_count INTEGER NOT NULL CHECK (decision_count >= 0),
  cleaned_count INTEGER NOT NULL CHECK (cleaned_count >= 0),
  finalized_count INTEGER NOT NULL CHECK (finalized_count >= 0),
  retained_count INTEGER NOT NULL CHECK (retained_count >= 0),
  quarantined_count INTEGER NOT NULL CHECK (quarantined_count >= 0),
  already_clean_count INTEGER NOT NULL CHECK (already_clean_count >= 0),
  reclaimed_bytes INTEGER NOT NULL CHECK (reclaimed_bytes >= 0),
  result TEXT NOT NULL CHECK (result = 'SUCCEEDED'),
  CHECK (
    decision_count = cleaned_count + finalized_count + retained_count +
      quarantined_count + already_clean_count
  )
) STRICT;

CREATE TABLE editor_recovery_decisions (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36
      AND id = lower(id)
      AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  run_id TEXT NOT NULL
    REFERENCES editor_recovery_runs(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('workspace', 'unknown_workspace')),
  resource_key_sha256 TEXT NOT NULL CHECK (length(resource_key_sha256) = 64),
  session_id TEXT REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  workspace_key TEXT,
  initial_state TEXT,
  final_state TEXT,
  decision TEXT NOT NULL CHECK (
    decision IN (
      'RETAIN_ACTIVE',
      'CLEANED',
      'FINALIZED',
      'ALREADY_CLEAN',
      'QUARANTINE_REQUIRED'
    )
  ),
  reason_code TEXT NOT NULL CHECK (length(reason_code) >= 1),
  manifest_sha256 TEXT CHECK (manifest_sha256 IS NULL OR length(manifest_sha256) = 64),
  session_fencing_token INTEGER CHECK (
    session_fencing_token IS NULL OR session_fencing_token >= 1
  ),
  workspace_fencing_token INTEGER CHECK (
    workspace_fencing_token IS NULL OR workspace_fencing_token >= 1
  ),
  logical_size_bytes INTEGER NOT NULL CHECK (logical_size_bytes >= 0),
  reclaimed_bytes INTEGER NOT NULL CHECK (reclaimed_bytes >= 0),
  details_json TEXT NOT NULL
    CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (run_id, resource_type, resource_key_sha256)
) STRICT;

CREATE INDEX editor_recovery_runs_completed_idx
ON editor_recovery_runs(completed_at);

CREATE INDEX editor_recovery_decisions_run_idx
ON editor_recovery_decisions(run_id, decision);

CREATE TRIGGER editor_recovery_runs_no_update
BEFORE UPDATE ON editor_recovery_runs
BEGIN
  SELECT RAISE(ABORT, 'editor_recovery_runs is immutable');
END;

CREATE TRIGGER editor_recovery_runs_no_delete
BEFORE DELETE ON editor_recovery_runs
BEGIN
  SELECT RAISE(ABORT, 'editor_recovery_runs is immutable');
END;

CREATE TRIGGER editor_recovery_decisions_no_update
BEFORE UPDATE ON editor_recovery_decisions
BEGIN
  SELECT RAISE(ABORT, 'editor_recovery_decisions is immutable');
END;

CREATE TRIGGER editor_recovery_decisions_no_delete
BEFORE DELETE ON editor_recovery_decisions
BEGIN
  SELECT RAISE(ABORT, 'editor_recovery_decisions is immutable');
END;
`
})
