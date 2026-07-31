export const migration005 = Object.freeze({
  version: 5,
  name: 'validation_evidence_and_review_sets',
  sql: `
CREATE TABLE editor_validation_evidence (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36
      AND id = lower(id)
      AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  candidate_set_id TEXT NOT NULL
    REFERENCES editor_candidate_artifact_sets(id) ON DELETE RESTRICT,
  candidate_manifest_sha256 TEXT NOT NULL CHECK (length(candidate_manifest_sha256) = 64),
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version >= 1),
  profile_sha256 TEXT NOT NULL CHECK (length(profile_sha256) = 64),
  profile_set_version TEXT NOT NULL,
  profile_set_sha256 TEXT NOT NULL CHECK (length(profile_set_sha256) = 64),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN (
    'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'
  )),
  exit_code INTEGER,
  signal TEXT,
  output_bytes INTEGER NOT NULL CHECK (output_bytes >= 0),
  log_artifact_id TEXT NOT NULL
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  finished_at INTEGER NOT NULL CHECK (finished_at >= created_at),
  UNIQUE (candidate_set_id, profile_id, request_sha256)
) STRICT;

CREATE INDEX editor_validation_evidence_candidate_idx
ON editor_validation_evidence(candidate_set_id, profile_id, created_at);

CREATE TRIGGER editor_validation_evidence_no_update
BEFORE UPDATE ON editor_validation_evidence
BEGIN
  SELECT RAISE(ABORT, 'editor_validation_evidence is immutable');
END;

CREATE TRIGGER editor_validation_evidence_no_delete
BEFORE DELETE ON editor_validation_evidence
BEGIN
  SELECT RAISE(ABORT, 'editor_validation_evidence is immutable');
END;

CREATE TABLE editor_review_sets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
    REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  candidate_set_id TEXT NOT NULL
    REFERENCES editor_candidate_artifact_sets(id) ON DELETE RESTRICT,
  candidate_manifest_sha256 TEXT NOT NULL CHECK (length(candidate_manifest_sha256) = 64),
  forward_patch_sha256 TEXT NOT NULL CHECK (length(forward_patch_sha256) = 64),
  validation_manifest_artifact_id TEXT NOT NULL
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  validation_manifest_sha256 TEXT NOT NULL CHECK (length(validation_manifest_sha256) = 64),
  review_summary_artifact_id TEXT NOT NULL
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  review_summary_sha256 TEXT NOT NULL CHECK (length(review_summary_sha256) = 64),
  path_policy_version TEXT NOT NULL,
  profile_set_version TEXT NOT NULL,
  profile_set_sha256 TEXT NOT NULL CHECK (length(profile_set_sha256) = 64),
  review_policy_version TEXT NOT NULL,
  review_policy_sha256 TEXT NOT NULL CHECK (length(review_policy_sha256) = 64),
  validation_evidence_json TEXT NOT NULL CHECK (json_valid(validation_evidence_json)),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (session_id, session_version),
  UNIQUE (session_id, request_id)
) STRICT;

CREATE TRIGGER editor_review_sets_no_update
BEFORE UPDATE ON editor_review_sets
BEGIN
  SELECT RAISE(ABORT, 'editor_review_sets is immutable');
END;

CREATE TRIGGER editor_review_sets_no_delete
BEFORE DELETE ON editor_review_sets
BEGIN
  SELECT RAISE(ABORT, 'editor_review_sets is immutable');
END;
`
})
