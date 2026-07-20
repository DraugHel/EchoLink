import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendTaskRunEvent,
  createTaskRun,
  defaultAgentPlan,
  finishTaskRun,
  normalizeRunPlan,
  readTaskRunControl,
  requestTaskRunCancel,
  updateTaskRun
} from '../server/lib/taskRunState.js'

class FakeDb {
  constructor() {
    this.runs = new Map()
    this.events = []
    this.nextRunId = 1
    this.nextEventId = 1
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    if (normalized.startsWith('INSERT INTO task_runs')) {
      return {
        run: (taskId, plan, progress, startedAt, updatedAt) => {
          const id = this.nextRunId++
          this.runs.set(id, {
            id,
            task_id: taskId,
            status: 'running',
            phase: 'queued',
            plan,
            current_step: 0,
            progress,
            control_state: 'active',
            result: null,
            error: null,
            started_at: startedAt,
            finished_at: null,
            updated_at: updatedAt
          })
          return { lastInsertRowid: id, changes: 1 }
        }
      }
    }

    if (normalized.startsWith('INSERT INTO task_run_events')) {
      return {
        run: (
          runId,
          eventType,
          message,
          detail,
          stepIndex,
          createdAt
        ) => {
          this.events.push({
            id: this.nextEventId++,
            run_id: runId,
            event_type: eventType,
            message,
            detail,
            step_index: stepIndex,
            created_at: createdAt
          })
          return { changes: 1 }
        }
      }
    }

    if (
      normalized.startsWith('UPDATE task_runs SET updated_at = ?')
    ) {
      return {
        run: (...values) => {
          const runId = values.at(-1)
          const run = this.runs.get(runId)
          if (!run) return { changes: 0 }

          let valueIndex = 0
          run.updated_at = values[valueIndex++]

          const mappings = [
            ['phase = ?', 'phase'],
            ['plan = ?', 'plan'],
            ['current_step = ?', 'current_step'],
            ['progress = ?', 'progress'],
            ['control_state = ?', 'control_state']
          ]

          for (const [fragment, key] of mappings) {
            if (normalized.includes(fragment)) {
              run[key] = values[valueIndex++]
            }
          }

          return { changes: 1 }
        }
      }
    }

    if (
      normalized.startsWith('UPDATE task_runs SET status = ?, phase = ?') &&
      normalized.includes('finished_at = ?')
    ) {
      return {
        run: (
          status,
          phase,
          result,
          error,
          progress,
          controlState,
          finishedAt,
          updatedAt,
          runId
        ) => {
          const run = this.runs.get(runId)
          if (!run) return { changes: 0 }
          Object.assign(run, {
            status,
            phase,
            result,
            error,
            progress,
            control_state: controlState,
            finished_at: finishedAt,
            updated_at: updatedAt
          })
          return { changes: 1 }
        }
      }
    }

    if (normalized.startsWith('SELECT control_state')) {
      return {
        get: runId => {
          const run = this.runs.get(runId)
          return run
            ? { control_state: run.control_state }
            : undefined
        }
      }
    }

    if (
      normalized.includes("control_state = 'cancel_requested'")
    ) {
      return {
        run: (updatedAt, runId) => {
          const run = this.runs.get(runId)
          if (
            !run ||
            run.status !== 'running' ||
            run.control_state !== 'active'
          ) {
            return { changes: 0 }
          }

          run.control_state = 'cancel_requested'
          run.progress = 'Abbruch wurde angefordert'
          run.updated_at = updatedAt
          return { changes: 1 }
        }
      }
    }

    throw new Error(`Unbekanntes Fake-SQL: ${normalized}`)
  }
}

test('Agentenplan ist begrenzt und stabil strukturiert', () => {
  const plan = defaultAgentPlan({ title: 'Morning Brief' })

  assert.equal(plan.length, 5)
  assert.equal(plan[0].id, 'understand')
  assert.match(plan[0].title, /Morning Brief/)

  const normalized = normalizeRunPlan([
    'Erster Schritt',
    { id: 'second', title: 'Zweiter Schritt' },
    null,
    ...Array.from({ length: 20 }, (_, index) => `Extra ${index}`)
  ])

  assert.equal(normalized.length, 8)
  assert.equal(normalized[0].title, 'Erster Schritt')
})

test('Run-State speichert Fortschritt, Events und Abschluss', () => {
  const db = new FakeDb()
  const plan = defaultAgentPlan({ title: 'Testlauf' })
  const runId = createTaskRun(db, 1, 100, plan)

  updateTaskRun(db, runId, {
    phase: 'running',
    currentStep: 1,
    progress: 'Recherche läuft',
    updatedAt: 110
  })

  appendTaskRunEvent(db, runId, {
    type: 'tool_started',
    message: 'web_search wird ausgeführt',
    detail: 'EchoLink',
    stepIndex: 1,
    createdAt: 111
  })

  assert.equal(readTaskRunControl(db, runId), 'active')

  const cancelResult = requestTaskRunCancel(db, runId)
  assert.equal(cancelResult.changes, 1)
  assert.equal(readTaskRunControl(db, runId), 'cancel_requested')

  finishTaskRun(db, runId, {
    status: 'failed',
    phase: 'cancelled',
    controlState: 'cancelled',
    finishedAt: 120
  })

  const run = db.runs.get(runId)

  assert.equal(run.phase, 'cancelled')
  assert.equal(run.control_state, 'cancelled')
  assert.equal(run.finished_at, 120)
  assert.equal(db.events.length, 1)
  assert.equal(db.events[0].step_index, 1)
})
