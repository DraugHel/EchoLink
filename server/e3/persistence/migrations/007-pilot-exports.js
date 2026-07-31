export const migration007 = Object.freeze({
  version: 7,
  name: 'pilot_export_records',
  sql: `
CREATE TABLE editor_pilot_export_records (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36
      AND id = lower(id)
      AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL UNIQUE
    REFERENCES editor_approval_records(id) ON DELETE RESTRICT,
  approved_session_version INTEGER NOT NULL
    CHECK (approved_session_version >= 1),
  exported_session_version INTEGER NOT NULL
    CHECK (exported_session_version = approved_session_version + 2),
  review_set_id TEXT NOT NULL
    REFERENCES editor_review_sets(id) ON DELETE RESTRICT,
  candidate_set_id TEXT NOT NULL
    REFERENCES editor_candidate_artifact_sets(id) ON DELETE RESTRICT,
  base_commit TEXT NOT NULL
    CHECK (
      length(base_commit) = 40
      AND base_commit = lower(base_commit)
      AND base_commit NOT GLOB '*[^0-9a-f]*'
    ),
  candidate_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(candidate_manifest_sha256) = 64
      AND candidate_manifest_sha256 = lower(candidate_manifest_sha256)
      AND candidate_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  forward_patch_sha256 TEXT NOT NULL
    CHECK (
      length(forward_patch_sha256) = 64
      AND forward_patch_sha256 = lower(forward_patch_sha256)
      AND forward_patch_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  reverse_patch_sha256 TEXT NOT NULL
    CHECK (
      length(reverse_patch_sha256) = 64
      AND reverse_patch_sha256 = lower(reverse_patch_sha256)
      AND reverse_patch_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  validation_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(validation_manifest_sha256) = 64
      AND validation_manifest_sha256 = lower(validation_manifest_sha256)
      AND validation_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  review_summary_sha256 TEXT NOT NULL
    CHECK (
      length(review_summary_sha256) = 64
      AND review_summary_sha256 = lower(review_summary_sha256)
      AND review_summary_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  approval_statement_sha256 TEXT NOT NULL
    CHECK (
      length(approval_statement_sha256) = 64
      AND approval_statement_sha256 = lower(approval_statement_sha256)
      AND approval_statement_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  export_policy_version TEXT NOT NULL
    CHECK (length(export_policy_version) >= 1),
  export_policy_sha256 TEXT NOT NULL
    CHECK (
      length(export_policy_sha256) = 64
      AND export_policy_sha256 = lower(export_policy_sha256)
      AND export_policy_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  export_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(export_manifest_sha256) = 64
      AND export_manifest_sha256 = lower(export_manifest_sha256)
      AND export_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  package_artifact_id TEXT NOT NULL UNIQUE
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  package_sha256 TEXT NOT NULL
    CHECK (
      length(package_sha256) = 64
      AND package_sha256 = lower(package_sha256)
      AND package_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  package_size_bytes INTEGER NOT NULL CHECK (package_size_bytes >= 1),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 160),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (session_id, request_id),
  UNIQUE (session_id, exported_session_version)
) STRICT;

CREATE INDEX editor_pilot_export_records_session_idx
ON editor_pilot_export_records(session_id, created_at);

CREATE TRIGGER editor_pilot_export_records_no_update
BEFORE UPDATE ON editor_pilot_export_records
BEGIN
  SELECT RAISE(ABORT, 'editor_pilot_export_records is immutable');
END;

CREATE TRIGGER editor_pilot_export_records_no_delete
BEFORE DELETE ON editor_pilot_export_records
BEGIN
  SELECT RAISE(ABORT, 'editor_pilot_export_records is immutable');
END;
`
})
