const DAY_SECONDS = 24 * 60 * 60

function positiveDays(value, fallback) {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback
}

export function cleanupScheduledTasks(
  db,
  {
    now = Math.floor(Date.now() / 1000),
    onceRetentionDays = 30,
    runRetentionDays = 90
  } = {}
) {
  const timestamp = Math.floor(Number(now))

  if (!Number.isFinite(timestamp)) {
    throw new Error('Ungültiger Cleanup-Zeitpunkt')
  }

  const onceDays = positiveDays(
    onceRetentionDays,
    30
  )

  const runDays = positiveDays(
    runRetentionDays,
    90
  )

  const onceCutoff =
    timestamp - onceDays * DAY_SECONDS

  const runCutoff =
    timestamp - runDays * DAY_SECONDS

  return db.transaction(() => {
    const oldRuns = db.prepare(`
      DELETE FROM task_runs
      WHERE
        status IN ('success', 'failed')
        AND finished_at IS NOT NULL
        AND finished_at < ?
    `).run(runCutoff)

    const onceTaskRuns = db.prepare(`
      DELETE FROM task_runs
      WHERE task_id IN (
        SELECT id
        FROM scheduled_tasks
        WHERE
          schedule_kind = 'once'
          AND enabled = 0
          AND locked_at IS NULL
          AND COALESCE(
            last_run_at,
            updated_at,
            created_at,
            0
          ) < ?
      )
    `).run(onceCutoff)

    const onceTasks = db.prepare(`
      DELETE FROM scheduled_tasks
      WHERE
        schedule_kind = 'once'
        AND enabled = 0
        AND locked_at IS NULL
        AND COALESCE(
          last_run_at,
          updated_at,
          created_at,
          0
        ) < ?
    `).run(onceCutoff)

    return {
      deletedTasks: onceTasks.changes,
      deletedRuns:
        oldRuns.changes + onceTaskRuns.changes,
      onceCutoff,
      runCutoff
    }
  })()
}
