# ADR-006: Validation broker, containers, and network

- **Status:** accepted
- **Date:** 2026-07-27
- **Scope:** E3 V1

## Context

Tests, builds, package scripts, development servers, and browser flows execute
candidate-controlled code. The current Playwright launcher has useful
hardening but uses hostnetwork and permits the production origin. The host
Docker daemon is rootful. `rootlesskit` exists, while a complete rootless or
Podman setup is not currently available.

Production uses Node `24.18.0`; CI currently uses Node 22. A reproducible
validator cannot leave the runtime version implicit.

## Decision

Validation runs through the fixed-profile broker defined by ADR-001 and always
uses a frozen validation snapshot from ADR-002.

### Profile registry

Initial profile IDs:

- `diff:check`
- `syntax:javascript`
- `syntax:json`
- `test:targeted`
- `test:full`
- `build:frontend`
- `sqlite:integrity`
- `playwright:ui`

Each immutable profile version defines:

- exact image digest and runtime version
- entrypoint and argument template
- input and output mounts
- non-root UID/GID
- environment allowlist
- network mode and allowed peers
- CPU, memory, PID, file, output, and time limits
- allowed exit codes
- cleanup and artifact rules

The request selects only profile ID/version and trusted snapshot handle.
Caller-provided command, executable, arbitrary argument, image, mount, device,
network, environment, user, capability, or privilege fields are invalid.

### Runtime alignment

The first EchoLink validation image targets exact Node `24.18.0`, matching the
audited production runtime. Before the runner is enabled, CI must be changed
to the same supported version or the project must explicitly adopt a tested
version matrix. Lockfile hashes and image digest are part of every validation
manifest.

Dependency installation is not a session operation. Trusted image-building
uses both lockfiles and `npm ci`; lifecycle scripts run only in that controlled
build stage. Dependency layers are read-only during validation.

### Container baseline

Every container uses:

- immutable allowlisted image digest
- non-root user
- read-only root filesystem
- all capabilities dropped
- `no-new-privileges`
- standard seccomp and an E3 AppArmor profile when available
- explicit read-only dependency mounts
- validation snapshot and bounded output/tmpfs mounts only
- PID, CPU, memory, open-file, output-byte, and wall-time limits
- labels for session, run, profile, lease owner, and fencing token

The broker rejects privileged mode, host PID/IPC, devices, Docker socket,
production mounts, and hostnetwork.

### Environment and data

Profiles construct an allowlist from constants and session-safe values.
Production `process.env` is never inherited wholesale.

Allowed examples:

- deterministic locale/timezone
- `NODE_ENV=test`
- assigned internal test URL
- synthetic database path
- bounded temp/cache paths

Forbidden examples:

- API keys, cookies, OAuth material, production DB paths
- HOME or credential helper state from production
- PM2 and deployment configuration

SQLite validation creates a new synthetic database. A database file from
production, backup, upload, or another session is never mounted.

### Network

Profiles default to no network.

The UI profile creates a new Docker internal bridge for exactly:

- one test application container
- one Playwright container

The application binds only within that network. Playwright receives an exact
internal origin. There is:

- no hostnetwork
- no production port 3000
- no host gateway alias
- no route to production containers
- no Internet egress

If a future test requires external services, it uses an explicit local stub or
a separately reviewed domain proxy. It never silently enables general egress.

### Output integrity

The broker streams bounded stdout/stderr through redaction. On completion it:

1. terminates owned process/container groups
2. verifies the frozen candidate manifest
3. records exit, timeout, resource, and cleanup results
4. publishes hashed logs/screenshots
5. returns the exact candidate and profile hashes

A cleanup failure prevents a successful validation result.

## Consequences

- project code executes away from production data and services
- rootful Docker risk is concentrated in a small broker
- validator images and dependency caches require explicit lifecycle management
- UI tests require two isolated containers rather than reusing production
- Node version drift becomes visible and blocks enablement

## Deferred

- rootless Docker migration
- arbitrary external integration tests
- dynamic package installation
- host browser profiles, downloads, uploads, or general Playwright code
- intelligent replacement of mandatory full gates

## Rejected alternatives

- reuse the production Playwright MCP or origin
- mount `/root/echolink` into validation
- expose Docker socket to worker or model
- `docker run` assembled from caller strings
- hostnetwork with a different port
- inherit production environment and remove a few known secrets
- run tests in the live edit workspace

## Verification

- sentinel secret and production paths are absent inside every profile
- attempts to reach port 3000, host gateway, production containers, and public
  Internet fail
- arbitrary image, mount, argument, capability, and environment requests fail
- resource exhaustion is killed within hard limits
- forked processes and containers do not survive timeout/cancellation
- candidate mutation during validation is detected
- CI/runtime/profile version mismatch blocks release
