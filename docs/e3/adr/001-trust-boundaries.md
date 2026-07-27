# ADR-001: Trust boundaries and process identities

- **Status:** accepted
- **Date:** 2026-07-27
- **Scope:** E3 V1

## Context

The current EchoLink backend, worker, web MCP, and Playwright MCP run as root.
The existing terminal path can execute shell strings and inherits the
production environment. Neither application-level path checks nor a Git
worktree can form a hard security boundary in that process.

The host has rootful Docker with AppArmor, seccomp, and cgroup namespaces.
There is no existing `echolink-editor` account, and the Docker group has no
members. The production `.env` is `root:root` with mode `0600`.

## Decision

E3 uses four distinct responsibilities:

1. **Control plane**
   - remains in the authenticated EchoLink backend
   - authorizes requests, coordinates state, and records audit events
   - cannot accept free-form commands or arbitrary host paths

2. **Workspace manager**
   - trusted service responsible for the dedicated mirror, worktrees,
     manifests, leases, and artifact publication
   - converts session IDs into internally generated workspace handles
   - is the only component allowed to mutate mirror/worktree metadata

3. **Editor worker**
   - later runs as a dedicated unprivileged `echolink-editor` identity
   - owns only assigned editable workspace content
   - has no supplementary Docker group, Docker socket, production environment,
     PM2, deploy, push, or production write capability
   - receives schema-validated operations rather than commands

4. **Validator broker**
   - minimal root-owned launcher required by the current rootful Docker host
   - accepts only a versioned fixed-profile request
   - is not exposed directly to the model
   - never accepts command, executable, image, mount, network, environment, or
     privilege choices from the caller

A trusted productive apply coordinator is deferred and absent from V1.

## Capability matrix

| Capability | Control plane | Workspace manager | Editor worker | Validator broker |
|---|---:|---:|---:|---:|
| authorize user | yes | no | no | no |
| transition session | coordinate | fenced writes | no | result only |
| mutate editor files | no | lifecycle only | assigned workspace | validation snapshot only |
| mutate Git metadata | no | dedicated mirror only | no | no |
| access production source | current root process can read | read baseline through fixed source | no | no |
| access production secrets/data | must not forward | no | no | no |
| access Docker socket | no | no | no | broker implementation only |
| execute arbitrary shell | no | no | no | no |
| productively apply/deploy | no | no | no | no |

## Broker protocol

The broker request contains only:

- request ID and session ID
- validation snapshot handle issued by the manager
- registered profile ID and profile version
- expected candidate-manifest SHA-256
- lease owner and fencing token

The broker resolves all host paths and profile details from trusted state. It
returns structured status, bounded log artifact references, resource use, and
the candidate-manifest hash it actually validated.

## Consequences

- A worker defect cannot directly write production files or control Docker.
- The root-owned broker becomes small enough for focused review and negative
  testing.
- E3 requires IPC authentication, ownership checks, and fencing.
- Creating the user or service is a later server operation with its own patch
  and rollback; this ADR performs no such change.
- Rootless Docker may later replace the root broker, but only after its UID/GID
  mapping, networking, systemd lifecycle, and isolation tests are complete.

## Rejected alternatives

- **Run all E3 code in the existing root backend:** no hard boundary.
- **Add the worker to the Docker group:** effectively grants root-equivalent
  host control.
- **Reuse the terminal runner:** accepts free-form shell and production env.
- **Use AppArmor as the only boundary:** defense in depth cannot replace
  identity, mount, and network separation.
- **Require rootless immediately:** current prerequisites are not fully
  installed or verified.

## Verification

- worker process cannot read `.env` or create a production canary
- worker has no Docker socket and no Docker group membership
- unknown broker profile or caller-supplied execution field is rejected
- a stale fencing token cannot launch or publish validation
- process inventory and service ownership are visible in E3 status
