# ADR-002: Mirror, worktree, and workspace model

- **Status:** accepted
- **Date:** 2026-07-27
- **Scope:** E3 V1

## Context

The production repository is `/root/echolink`. It currently has one worktree,
its `.git` directory is approximately 173 MB, and Git reports no garbage.
Existing dependency trees use approximately 320 MB. Full project copies with
dependencies would waste the host's limited free disk.

A worktree attached directly to the production repository would share
production Git metadata. OverlayFS would introduce privileged mount and
recovery complexity before it is needed.

## Decision

E3 uses a dedicated local bare mirror plus detached session worktrees. The
default storage root is:

```text
/var/lib/echolink-editor/
  repo.git/
  workspaces/<session-id>/tree/
  artifacts/<session-id>/
  runtime/
  locks/
  quarantine/
```

The path is a configurable deployment value, but it must be outside
`/root/echolink`, production data, backups, and uploads.

### Mirror rules

- The workspace manager alone owns and mutates `repo.git`.
- The mirror is populated from the local production repository through a
  trusted fixed source configuration.
- It contains no push URL, SSH key, access token, credential helper, or
  automatic network fetch.
- A session references a full 40-character commit SHA, never a branch, tag,
  short SHA, or mutable ref.
- Before provisioning, the manager verifies the object is a commit and is
  reachable from the configured trusted baseline history.
- Mirror update and prune operations require a global fenced lock.

### Worktree rules

- Each session receives one manager-generated UUID and one detached worktree.
- The agent cannot choose a host path, worktree name, Git ref, or repository.
- Worktree Git metadata remains manager-owned and is not writable by the
  editor worker.
- The editor worker edits only the working files through the operation API; it
  does not execute Git.
- Provisioning records base SHA, tree SHA, path, owner, creation time, and
  manifest SHA-256 before entering `EDITING`.
- The baseline is scanned for forbidden special files and symlinks. Symlinks
  may exist as source facts but are never followed or mutated in V1.

### Dependencies and validation snapshots

`node_modules`, client dependencies, `dist`, coverage, logs, databases, and
build outputs are not copied into session worktrees.

Validation never executes in the canonical editing worktree. The manager
creates a frozen candidate snapshot from:

1. the exact base commit
2. the frozen forward patch
3. the candidate manifest

The validator may write only inside this ephemeral snapshot and designated
tmpfs/output mounts. Dependency layers are immutable and keyed by:

- root lockfile SHA-256
- client lockfile SHA-256
- exact Node runtime
- validator image/profile version

After validation, the manager verifies that the frozen patch and manifest have
not changed.

## Workspace manifest

The manager-owned manifest includes:

- schema version
- session ID and workspace key
- base commit and tree SHA
- canonical workspace path
- manager and worker ownership
- creation and heartbeat times
- current fencing token
- allowed roots and expected subpaths
- associated processes, containers, and port leases
- candidate patch and manifest hashes when frozen

The editable tree cannot modify or replace this manifest.

## Cleanup

- successful completed sessions remove their worktree promptly
- failed or ambiguous worktrees move to quarantine within the same filesystem
- worktree removal uses canonical manager state and explicit paths
- Git worktree prune occurs only after DB, lease, process, and manifest
  reconciliation
- no cleanup path is derived directly from user or agent input

## Consequences

- Worktrees provide efficient Git-native snapshots without coupling to
  production Git metadata.
- The mirror and worktree manager are trusted components.
- Dependencies and build output are shared or ephemeral, not multiplied per
  session.
- Frozen validation snapshots prevent tests from modifying the reviewed edit
  workspace.

## Rejected alternatives

- **Direct production worktree:** shares production Git metadata.
- **Full copy with dependencies:** excessive disk and slow cleanup.
- **OverlayFS for V1 editing:** unnecessary privileged mount complexity.
- **Run tests in the edit worktree:** untrusted code could alter the candidate
  after review.

## Verification

- concurrent provisioning cannot reuse a workspace or mirror lock
- branches/tags/short SHAs and unreachable commits are rejected
- the worker cannot write `repo.git` or another session
- manifest tampering and symlink traversal are detected
- crash at every provisioning step is recovered or quarantined
- dependency caches are read-only and a cache-key mismatch fails closed
