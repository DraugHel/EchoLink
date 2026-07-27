# ADR-008: Recovery, reaper, quotas, and monitoring

- **Status:** accepted
- **Date:** 2026-07-27
- **Scope:** E3 V1

## Context

Worktrees, processes, containers, ports, patches, logs, screenshots, locks, and
temporary files can outlive a crashed process. Cleanup is itself destructive
and must not rely on a path, heartbeat, or wall-clock timeout alone.

The audited host has approximately 20 GB free while Docker already uses
8.515 GB of images and 6.618 GB of inactive build cache. E3 must neither grow
without bound nor prune unrelated Docker resources.

## Decision

E3 uses SQLite leases with monotonic fencing tokens, OS locks for host-local
critical sections, manager-owned manifests, startup recovery, an hourly
conservative reaper, and explicit disk/resource quotas.

### Leases and fencing

A lease records:

- resource type and canonical key
- owner instance ID
- acquisition and expiry time
- monotonically increasing fencing token
- last heartbeat

Every state-changing manager, worker, validator, export, cleanup, and future
apply request must present the current token. Lease expiry permits a takeover
attempt but is not enough to delete or mutate a resource.

Required resources:

- session
- workspace
- mirror update
- validation run
- port
- cleanup/reaper
- future global apply

OS `flock`-style locks protect mirror mutation, local cleanup, and future apply
against independent host processes. The DB lease remains the audit truth.

### Startup recovery

Before accepting new work:

1. open and verify `editor.db`
2. inspect unfinished migrations and artifact publication
3. reconcile sessions with manager manifests
4. identify owned worker process groups and labeled containers
5. reconcile port and filesystem locks
6. check interrupted export and future apply journals
7. resume only unambiguous idempotent steps
8. quarantine ambiguous resources
9. emit one durable recovery event per decision

Recovery never guesses success. `COMPLETED` requires durable proof.

### Reaper safety predicate

The reaper may remove a resource only when all are true:

- canonical path is below the configured E3 root
- DB row, session ID, workspace key, and manager manifest agree
- no valid lease or newer fencing token exists
- no associated live process, container, or port owner exists
- session is not active, applying, reverting, pinned, or protected
- retention deadline has passed
- removal plan contains explicit known paths

If any check is false or unavailable, the resource is retained or moved to a
same-filesystem quarantine by the trusted manager. No recursive deletion uses
an untrusted or unresolved variable.

### Initial quotas

These are conservative defaults and remain configurable below hard ceilings:

| Resource | Default |
|---|---:|
| simultaneously active sessions | 5 |
| workspace logical size per session | 1 GiB |
| total active workspace logical size | 5 GiB |
| artifacts per session | 250 MiB |
| total unpinned artifacts | 5 GiB |
| stdout/stderr per validation run | 10 MiB |
| screenshots per validation run | 20 |
| retained failed/quarantined workspace | 24 hours |
| retained unpinned patch/manifests | 180 days |

Completed workspaces are removed promptly after export and durable audit.
Pinned artifacts do not expire automatically but still count toward monitoring
and require an explicit administrative storage policy.

Provisioning stops before validation when either:

- free disk is below 15 GiB or 20%, whichever is stricter (`soft`)
- projected work would cross that threshold

At below 10 GiB or 15%, whichever is stricter (`hard`), E3 rejects new work,
aborts nonessential queued validation, and runs only safe reconciliation.
Existing applying/reverting work is not introduced in V1.

E3 never runs automatic `docker system prune`, deletes an unlabelled Docker
object, or treats Docker's reported reclaimable cache as owned storage.

### Retention order

When above quota and safety predicates pass:

1. expired temporary validation snapshots
2. completed unpinned workspaces
3. expired bounded raw logs and screenshots
4. expired unpinned export packages
5. unreferenced content-addressed objects after a mark-and-sweep grace period

Manifests, patch hashes, validation summaries, semantic history, and audit
events remain according to the project audit policy even when large raw
artifacts expire.

### Monitoring

The authenticated system status exposes:

- sessions by state and oldest heartbeat
- active workers, validation runs, containers, and port leases
- workspace, artifact, quarantine, and free-disk bytes
- soft/hard pressure state
- reaper last start, finish, result, reclaimed bytes, and refusal reasons
- recovery last start, finish, result, and quarantined items
- mirror health and last update
- DB quick-check and last full integrity-check
- orphan candidates and cleanup backlog

Metrics and logs contain IDs and counters, not code, secrets, full paths with
user data, or unrestricted command output.

## Consequences

- cleanup remains conservative and auditable
- ambiguous resources consume space until reviewed
- quotas may reject legitimate large changes rather than endanger the host
- content-addressed garbage collection requires reference accounting
- no automatic Docker pruning means operations retains responsibility for
  unrelated Docker storage

## Rejected alternatives

- delete solely because heartbeat is old
- trust a workspace-provided path or manifest
- run broad recursive deletion or Docker prune
- ignore pinned items in disk-pressure reporting
- report recovery success before reconciliation is durable
- allow sessions to start when projected disk crosses the stop threshold

## Verification

- stale worker with old token cannot write or prevent takeover
- live process/container prevents cleanup despite expired lease
- forged manifest, symlinked root, and path mismatch enter quarantine
- crash during every cleanup and publication step is idempotently recovered
- quota boundary and projected-size tests fail closed
- reaper never removes unlabelled Docker resources
- status accurately reports injected orphan, pressure, and integrity failures
