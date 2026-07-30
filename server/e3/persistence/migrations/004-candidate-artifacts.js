export const migration004 = Object.freeze({
  version: 4,
  name: 'candidate_artifact_sets',
  sql: `
CREATE TABLE editor_candidate_artifact_sets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES editor_sessions(id) ON DELETE RESTRICT,
  session_version INTEGER NOT NULL CHECK (session_version >= 0),
  base_commit TEXT NOT NULL CHECK (length(base_commit) = 40),
  tree_sha TEXT NOT NULL CHECK (length(tree_sha) = 40),
  candidate_manifest_artifact_id TEXT NOT NULL
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  forward_patch_artifact_id TEXT NOT NULL
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  reverse_patch_artifact_id TEXT NOT NULL
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  unified_diff_artifact_id TEXT NOT NULL
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  diff_stat_artifact_id TEXT NOT NULL
    REFERENCES editor_artifacts(id) ON DELETE RESTRICT,
  candidate_manifest_sha256 TEXT NOT NULL CHECK (length(candidate_manifest_sha256) = 64),
  forward_patch_sha256 TEXT NOT NULL CHECK (length(forward_patch_sha256) = 64),
  reverse_patch_sha256 TEXT NOT NULL CHECK (length(reverse_patch_sha256) = 64),
  unified_diff_sha256 TEXT NOT NULL CHECK (length(unified_diff_sha256) = 64),
  diff_stat_sha256 TEXT NOT NULL CHECK (length(diff_stat_sha256) = 64),
  path_policy_version TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (session_id, session_version)
) STRICT;

CREATE INDEX editor_candidate_artifact_sets_session_idx
ON editor_candidate_artifact_sets(session_id, created_at);
`
})
