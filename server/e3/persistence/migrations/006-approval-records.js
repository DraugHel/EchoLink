export const migration006 = Object.freeze({
  version: 6,
  name: 'bound_approval_records',
  sql: `
CREATE TABLE editor_approval_records (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36
      AND id = lower(id)
      AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  review_session_version INTEGER NOT NULL CHECK (review_session_version >= 1),
  approved_session_version INTEGER NOT NULL
    CHECK (approved_session_version = review_session_version + 1),
  review_set_id TEXT NOT NULL UNIQUE
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
  path_policy_version TEXT NOT NULL CHECK (length(path_policy_version) >= 1),
  profile_set_version TEXT NOT NULL CHECK (length(profile_set_version) >= 1),
  profile_set_sha256 TEXT NOT NULL
    CHECK (
      length(profile_set_sha256) = 64
      AND profile_set_sha256 = lower(profile_set_sha256)
      AND profile_set_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  review_policy_version TEXT NOT NULL CHECK (length(review_policy_version) >= 1),
  review_policy_sha256 TEXT NOT NULL
    CHECK (
      length(review_policy_sha256) = 64
      AND review_policy_sha256 = lower(review_policy_sha256)
      AND review_policy_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  approval_policy_version TEXT NOT NULL CHECK (length(approval_policy_version) >= 1),
  approval_policy_sha256 TEXT NOT NULL
    CHECK (
      length(approval_policy_sha256) = 64
      AND approval_policy_sha256 = lower(approval_policy_sha256)
      AND approval_policy_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  decision TEXT NOT NULL CHECK (decision = 'APPROVE'),
  statement_json TEXT NOT NULL
    CHECK (json_valid(statement_json) AND json_type(statement_json) = 'object'),
  statement_sha256 TEXT NOT NULL
    CHECK (
      length(statement_sha256) = 64
      AND statement_sha256 = lower(statement_sha256)
      AND statement_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 160),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (session_id, approved_session_version),
  UNIQUE (session_id, request_id)
) STRICT;

CREATE INDEX editor_approval_records_session_idx
ON editor_approval_records(session_id, created_at);

CREATE TRIGGER editor_approval_records_no_update
BEFORE UPDATE ON editor_approval_records
BEGIN
  SELECT RAISE(ABORT, 'editor_approval_records is immutable');
END;

CREATE TRIGGER editor_approval_records_no_delete
BEFORE DELETE ON editor_approval_records
BEGIN
  SELECT RAISE(ABORT, 'editor_approval_records is immutable');
END;
`
})
