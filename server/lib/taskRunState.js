const MAX_MESSAGE_LENGTH = 500
const MAX_DETAIL_LENGTH = 2_000
const MAX_PLAN_STEPS = 8

function safeText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}

export function normalizeRunPlan(plan) {
  if (!Array.isArray(plan)) return []

  return plan
    .map((step, index) => {
      const title = safeText(
        typeof step === 'string' ? step : step?.title,
        180
      )

      if (!title) return null

      return {
        id: safeText(step?.id || `step-${index + 1}`, 80),
        title
      }
    })
    .filter(Boolean)
    .slice(0, MAX_PLAN_STEPS)
}

export function defaultAgentPlan(task) {
  const title = safeText(task?.title || 'Agentenauftrag', 160)

  return [
    {
      id: 'understand',
      title: `Auftrag erfassen: ${title}`
    },
    {
      id: 'research',
      title: 'Benötigte Informationen und Quellen sammeln'
    },
    {
      id: 'verify',
      title: 'Ergebnisse prüfen und zusammenführen'
    },
    {
      id: 'compose',
      title: 'Nutzerfreundliches Ergebnis formulieren'
    },
    {
      id: 'quality',
      title: 'Abschluss und Vollständigkeit prüfen'
    }
  ]
}

export function createTaskRun(db, taskId, startedAt, plan = []) {
  const normalizedPlan = normalizeRunPlan(plan)
  const result = db.prepare(`
    INSERT INTO task_runs (
      task_id,
      status,
      phase,
      plan,
      current_step,
      progress,
      control_state,
      started_at,
      updated_at
    )
    VALUES (?, 'running', 'queued', ?, 0, ?, 'active', ?, ?)
  `).run(
    taskId,
    JSON.stringify(normalizedPlan),
    'Run wurde gestartet',
    startedAt,
    startedAt
  )

  return Number(result.lastInsertRowid)
}

export function appendTaskRunEvent(
  db,
  runId,
  {
    type,
    message = '',
    detail = '',
    stepIndex = null,
    createdAt = Math.floor(Date.now() / 1000)
  }
) {
  db.prepare(`
    INSERT INTO task_run_events (
      run_id,
      event_type,
      message,
      detail,
      step_index,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    safeText(type || 'info', 80),
    safeText(message, MAX_MESSAGE_LENGTH),
    safeText(detail, MAX_DETAIL_LENGTH),
    Number.isInteger(stepIndex) ? stepIndex : null,
    createdAt
  )
}

export function updateTaskRun(
  db,
  runId,
  {
    phase,
    plan,
    currentStep,
    progress,
    controlState,
    updatedAt = Math.floor(Date.now() / 1000)
  } = {}
) {
  const assignments = ['updated_at = ?']
  const values = [updatedAt]

  if (phase !== undefined) {
    assignments.push('phase = ?')
    values.push(safeText(phase, 80))
  }

  if (plan !== undefined) {
    assignments.push('plan = ?')
    values.push(JSON.stringify(normalizeRunPlan(plan)))
  }

  if (currentStep !== undefined) {
    assignments.push('current_step = ?')
    values.push(Math.max(0, Math.floor(Number(currentStep) || 0)))
  }

  if (progress !== undefined) {
    assignments.push('progress = ?')
    values.push(safeText(progress, MAX_MESSAGE_LENGTH))
  }

  if (controlState !== undefined) {
    assignments.push('control_state = ?')
    values.push(safeText(controlState, 80))
  }

  values.push(runId)

  db.prepare(`
    UPDATE task_runs
    SET ${assignments.join(', ')}
    WHERE id = ?
  `).run(...values)
}

export function finishTaskRun(
  db,
  runId,
  {
    status,
    phase,
    result = null,
    error = null,
    controlState = 'finished',
    progress,
    finishedAt = Math.floor(Date.now() / 1000)
  }
) {
  db.prepare(`
    UPDATE task_runs
    SET
      status = ?,
      phase = ?,
      result = ?,
      error = ?,
      progress = ?,
      control_state = ?,
      finished_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    status,
    safeText(phase, 80),
    result ? String(result).slice(0, 20_000) : null,
    error ? safeText(error, 4_000) : null,
    safeText(
      progress || (phase === 'success'
        ? 'Run erfolgreich abgeschlossen'
        : phase === 'cancelled'
          ? 'Run wurde abgebrochen'
          : 'Run ist fehlgeschlagen'),
      MAX_MESSAGE_LENGTH
    ),
    safeText(controlState, 80),
    finishedAt,
    finishedAt,
    runId
  )
}

export function readTaskRunControl(db, runId) {
  const row = db.prepare(`
    SELECT control_state
    FROM task_runs
    WHERE id = ?
  `).get(runId)

  return row?.control_state || 'missing'
}

export function requestTaskRunCancel(db, runId) {
  const now = Math.floor(Date.now() / 1000)

  return db.prepare(`
    UPDATE task_runs
    SET
      control_state = 'cancel_requested',
      progress = 'Abbruch wurde angefordert',
      updated_at = ?
    WHERE
      id = ?
      AND status = 'running'
      AND control_state = 'active'
  `).run(now, runId)
}
