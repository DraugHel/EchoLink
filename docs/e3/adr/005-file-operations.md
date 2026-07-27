# ADR-005: File operations and path safety

- **Status:** accepted
- **Date:** 2026-07-27
- **Scope:** E3 V1

## Context

String replacement is useful only when its preconditions are explicit.
Arbitrary file APIs, shell redirection, user-selected host paths, symlink
following, or best-effort matching would make edits non-deterministic and
permit workspace escape.

## Decision

The worker exposes a small operation registry. Each operation has a strict
versioned input schema, maximum sizes, deterministic preconditions, and an
audited result. Unknown fields and unknown operation versions are rejected.

### V1 read operations

- `read_file`
- `list_files`
- `stat_file`
- `search_text`

### V1 mutation operations

- `create_file`
- `replace_exact`
- `insert_before`
- `insert_after`
- `rename_file`
- `move_file`
- `delete_file`

`replace_block`, AST edits, binary writes, permission changes, executable-bit
changes, links, and recursive directory deletion are deferred.

## Path policy

The external API accepts a repository-relative POSIX path only.

It rejects:

- empty paths, absolute paths, NUL, backslash, `.` and `..` segments
- repeated separators, trailing separator, or non-normal form
- segments longer than 255 bytes or total paths longer than the configured
  conservative limit
- control characters and ambiguous Unicode normalization
- paths outside the internally assigned workspace handle

The V1 portable segment grammar is intentionally narrow:

```text
[A-Za-z0-9._-]+
```

Existing baseline paths outside that grammar may be read by an internal
manager handle after explicit inventory, but cannot be created, renamed, or
moved by V1.

Forbidden mutation roots and targets include:

- `.git`
- production `.env` and secret-like environment files; `.env.example` is the
  only explicit environment-file exception
- `data`, database files, session stores, backups, and uploads
- `node_modules`, `client/node_modules`, `dist`, coverage, and caches
- manager manifests, artifact storage, runtime, locks, and quarantine

The path-policy table is versioned. A policy change invalidates prior
validation and approval.

## Filesystem enforcement

For every existing path component the worker uses `lstat`-style inspection and
rejects symbolic links. A mutation target with link count greater than one is
rejected. The canonical parent must remain under the assigned workspace root.

Only one fenced writer may hold a workspace. Validators never mount the edit
workspace writable. These ownership rules reduce path-check/write races; path
checks are still repeated immediately before publication.

New content is written to an unpredictable manager-created temporary file in
the destination directory:

1. validate operation and expected state
2. verify parent and target without following links
3. verify expected preimage SHA-256 or required absence
4. write bounded UTF-8 content with exclusive creation
5. flush and fsync temporary content
6. recheck lease, fencing token, parent, and preimage
7. atomically rename within the same directory
8. fsync the directory
9. calculate and record postimage hash

On any failed precondition, no target mutation occurs.

## Operation semantics

### `create_file`

- target must not exist
- parent must already exist in V1
- content must be valid UTF-8 and below the file-size limit

### `replace_exact`

- expected file SHA-256 must match
- search bytes must occur exactly `expectedMatches`, which is `1` by default
- replacement count cannot exceed the explicit limit
- empty search strings are rejected

### `insert_before` and `insert_after`

- use an exact non-empty anchor
- anchor count must equal the explicit expected count
- insertion is idempotent only through request ID, not fuzzy detection

### `rename_file` and `move_file`

- source preimage hash must match
- destination must not exist
- both paths must pass the same policy and remain on the workspace filesystem

### `delete_file`

- target must be a regular file
- expected preimage hash must match
- operation journal retains the content-addressed preimage

## Limits

Initial limits are configuration with conservative hard ceilings:

- 2 MiB per editable text file
- 4 MiB per operation request
- 1,000 text-search results
- 100 mutations per session before explicit policy review
- 20 MiB aggregate changed text per session

Requests over a limit fail; they are not silently truncated.

## Consequences

- edits are reproducible and conflict-sensitive
- some valid repositories or refactors require a later policy extension
- high-level semantic operations can later compile into these primitives
- filesystem and operation results are independently auditable by hashes

## Rejected alternatives

- arbitrary read/write path
- shell-based `sed`, redirection, or patch commands
- fuzzy replacement without expected count and preimage
- following symlinks inside the worktree
- overwriting destination on rename
- silently editing binaries or generated output

## Verification

- traversal and encoding corpus across every operation
- symlink at every path segment and hardlink target
- concurrent swap attempt between check and publication
- zero, one, and many match behavior
- preimage mismatch leaves bytes and journal unchanged
- crash injection around write, fsync, rename, and DB event
- forbidden path table covers real EchoLink sensitive locations
