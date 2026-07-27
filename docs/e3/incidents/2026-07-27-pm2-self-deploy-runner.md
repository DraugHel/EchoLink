# PM2 self-deploy runner orphan

- **Date:** 2026-07-27
- **Affected commit:** `0940ae2804ea77f7acfcb2d1a6302b5750fc708b`
- **Scope:** existing EchoLink terminal/deploy path, not E3 V1
- **Outcome:** partial deploy, healthy main service, orphaned operation record

## Summary

An approved `npm run deploy` operation was launched from the PM2-managed
EchoLink server through a Node child process using `detached: true` and
`unref()`. The deploy completed its backup, tests, frontend build, and the
first `pm2 restart echolink`. PM2 then terminated the old service process tree,
including the detached terminal runner and its deploy descendants.

The replacement EchoLink process found the durable SQLite operation in
`running` state and correctly refused to run the command again. However, no
surviving owner remained to record completion or enforce the command timeout,
so the operation stayed `running` indefinitely.

## Evidence

The durable operation had:

- operation ID `cad2b4f5-e6d4-4a84-8517-af99ff262620`
- runner PID `798301`
- timeout `480000` ms
- `started_at` `1785171804764`
- no `finished_at`, exit code, error, or result

Read-only reconstruction showed:

1. database backup at `2026-07-27T17:03:25Z`
2. generated frontend artifacts at `2026-07-27T17:03:34Z`
3. new `echolink` process at `2026-07-27T17:03:37Z`
4. worker and MCP process start times unchanged from 2026-07-24
5. runner PID absent and no deploy or smoke-test descendants alive
6. production and MCP-Web health endpoints returning HTTP 200

This ordering places interruption at the first self-restart. The later worker
and MCP restarts, smoke checks, `pm2 save`, and success marker were not reached.

## Root cause

Process detachment creates a new session but does not establish an independent
service-manager ownership boundary. PM2 can terminate descendants of its
managed application during restart. The runner that owned execution,
heartbeat, timeout, and final persistence therefore shared the failure domain
of the service it restarted.

The previous integration test proved that a runner could use a separate
database connection and complete normally. It did not simulate a service
manager killing the complete parent process tree.

## Required controls

The existing EchoLink terminal path must:

1. launch self-disruptive operations as transient systemd services owned by
   PID 1, not as descendants of the PM2 application
2. use a deterministic unit name derived only from a validated operation UUID
3. fail closed when the trusted supervisor cannot launch; never fall back to a
   local child for self-disruptive commands
4. persist runner kind, supervisor reference, PID, and heartbeat
5. reconcile stale `running` operations against live supervisor/process state
6. mark a confirmed orphan as failed with an explicit “effects unknown”
   diagnostic and never execute it automatically again
7. retain an absolute command deadline across reconnects
8. test supervisor launch arguments, launch failure, live/ambiguous state, and
   orphan recovery

Frontend reconnect state must separately:

- clear a successful approval from pending action requests
- remove the reconnect banner when an HTTP/SSE connection is re-established,
  rather than only after the resumed operation finishes
- use a bounded retry horizon long enough for a normal PM2 restart

## E3 implication

This incident reinforces ADR-008: durable state alone is insufficient.
Completion requires a live, independently owned worker plus reconciliation,
and recovery must never guess success or repeat a non-idempotent operation.
The systemd mechanism in the existing operational terminal is not an E3
validator or productive-apply permission.
