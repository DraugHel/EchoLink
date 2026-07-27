# ADR-007: Review, approval, export, apply, and undo

- **Status:** accepted
- **Date:** 2026-07-27
- **Scope:** V1 export accepted; productive apply and post-apply undo deferred

## Context

`git apply --check` verifies applicability but cannot make a crash during
multiple production file writes atomic. Resetting Git history for undo could
destroy later unrelated changes. E3 therefore separates candidate preparation,
human approval, export, future guarded apply, and long-term immutable release
promotion.

## Decision

### Review freeze

A session can enter `READY_FOR_REVIEW` only when all mandatory profiles pass
against one frozen candidate. Review artifacts include:

- exact base commit
- ordered operation summary
- sorted file list and diff stat
- unified diff
- forward and reverse patch
- candidate file manifest
- validation manifest and bounded logs
- policy, schema, and profile versions
- semantic reason and affected components

All artifacts are immutable and hashed.

### Approval

An authenticated user approval records:

```json
{
  "sessionId": "uuid",
  "baseCommit": "40-character SHA",
  "candidateManifestSha256": "sha256",
  "patchSha256": "sha256",
  "validationManifestSha256": "sha256",
  "pathPolicyVersion": "version",
  "profileSetVersion": "version",
  "approvedBy": "user-id",
  "approvedAt": "UTC timestamp"
}
```

The approval transaction verifies current session version and all hashes.
Any reopen, mutation, revalidation under a different profile, policy change,
base change, or artifact mismatch revokes approval.

### V1 export

V1 ends by exporting an approved patch package. The package contains:

- machine-readable manifest
- forward and reverse patch
- unified diff and diff stat
- candidate and validation manifests
- semantic summary
- checksums
- a baseline-checking manual apply procedure

Export does not apply, commit, push, deploy, restart PM2, connect to a
production database, or start a production service.

The existing controlled Luna/manual server workflow remains outside E3 until
productive apply is separately enabled.

### Future guarded apply

`APPROVED -> APPLYING` is disabled in V1. Enabling it requires a new readiness
decision and all of:

1. independent trusted apply coordinator
2. global fenced apply lock
3. exact production HEAD and fully clean tree, including untracked files
4. re-verification of all approval and artifact hashes
5. durable journal and complete preimages
6. `git apply --check`
7. apply with explicit file allowlist
8. exact resulting diff-manifest verification
9. final validation
10. tested recovery for a crash at every step

This is practically transactional but not strictly crash-atomic across
multiple paths.

### Long-term promotion

Strict production-version atomicity requires immutable release directories and
an atomic `current` pointer switch. Persistent data remains external. Rollback
switches to a previously validated release. This release architecture is
deferred.

## Undo

### Before productive apply

Undo of an editor operation uses the operation journal and stored preimage, or
reconstructs the workspace from base plus remaining operations. It:

- requires the session lease and current fencing token
- verifies current postimage hash
- appends an inverse operation event
- invalidates patch, validation, review, approval, and export
- returns to `EDITING`

### After productive apply

Future productive undo creates a new revert session against the then-current
commit. It generates and validates an inverse patch and requires new approval.
Conflict enters `CONFLICTED`. E3 never runs `git reset --hard`, rewrites shared
history, or overwrites later changes.

## Consequences

- V1 delivers safe review and reproducible export without productive rights.
- Approval is evidence for exact bytes, not a broad permission.
- Productive apply remains a separately reviewable high-risk capability.
- Undo retains semantic and Git history.

## Rejected alternatives

- approval by session ID alone
- approval stored only in memory
- keep approval after mutation or profile change
- direct copy from workspace to production
- claim atomicity from `git apply --check`
- post-apply `git reset --hard`
- automatically resolve inverse-patch conflicts

## Verification

- changing each bound field independently invalidates approval
- mutation from review or approval atomically clears frozen state
- export bytes reproduce their recorded SHA-256
- V1 code paths cannot reach apply, deploy, push, or PM2
- future apply fault injection covers every journal step
- revert session refuses conflicts and unrelated changed preimages
