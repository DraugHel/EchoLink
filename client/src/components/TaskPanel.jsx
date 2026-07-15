import {
  useEffect,
  useMemo,
  useState
} from 'react'
import api from '../lib/api.js'

const TYPE_OPTIONS = [
  ['reminder', 'Erinnerung'],
  ['agent', 'Agent']
]

const SCHEDULE_OPTIONS = [
  ['once', 'Einmalig'],
  ['interval', 'Intervall'],
  ['cron', 'Cron']
]

const emptyTask = {
  title: '',
  prompt: '',
  taskType: 'reminder',
  scheduleKind: 'once',
  scheduleValue: '',
  timezone: 'Europe/Vienna',
  conversationTarget: 'auto',
  retentionDays: '',
  enabled: true
}

function buttonStyle({
  accent = false,
  danger = false,
  disabled = false
} = {}) {
  let background = 'var(--bg3)'
  let color = 'var(--text2)'
  let border = '1px solid var(--border)'

  if (accent) {
    background = 'var(--accent)'
    color = 'var(--user-text, #0d0d0d)'
    border = '1px solid transparent'
  }

  if (danger) {
    background = 'transparent'
    color = 'var(--danger)'
    border = '1px solid var(--danger)'
  }

  return {
    minHeight: 34,
    padding: '7px 11px',
    border,
    borderRadius: 8,
    background,
    color,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: accent ? 700 : 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1
  }
}

function fieldStyle() {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '9px 10px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    outline: 'none',
    background: 'var(--bg3)',
    color: 'var(--text1)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12
  }
}

function labelStyle() {
  return {
    marginBottom: 5,
    color: 'var(--text3)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.06em'
  }
}

function badgeStyle({ accent = false, muted = false } = {}) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 22,
    padding: '2px 7px',
    borderRadius: 999,
    border: accent
      ? '1px solid var(--accent)'
      : '1px solid var(--border)',
    background: accent
      ? 'var(--green-bg, rgba(46, 204, 113, 0.09))'
      : 'var(--bg3)',
    color: accent
      ? 'var(--accent)'
      : muted
        ? 'var(--text3)'
        : 'var(--text2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    lineHeight: 1
  }
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function toDateTimeLocal(value) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes())
  ].join('')
}

function fromDateTimeLocal(value) {
  if (!value) {
    throw new Error('Bitte einen Zeitpunkt auswählen.')
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new Error('Der Zeitpunkt ist ungültig.')
  }

  return date.toISOString()
}

function formatUnix(value, timezone) {
  if (!value) return null

  try {
    return new Date(Number(value) * 1000)
      .toLocaleString('de-AT', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone || undefined
      })
  } catch {
    return new Date(Number(value) * 1000)
      .toLocaleString('de-AT', {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
  }
}

function formatIso(value, timezone) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  try {
    return date.toLocaleString('de-AT', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone || undefined
    })
  } catch {
    return date.toLocaleString('de-AT', {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  }
}

function cronDescription(expression) {
  const parts = String(expression || '')
    .trim()
    .split(/\s+/)

  if (parts.length !== 5) return null

  const [minute, hour, day, month, weekday] = parts

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    day === '*' &&
    month === '*'
  ) {
    const time = `${pad(hour)}:${pad(minute)}`

    if (weekday === '*') {
      return `Täglich um ${time}`
    }

    const names = {
      0: 'Sonntag',
      1: 'Montag',
      2: 'Dienstag',
      3: 'Mittwoch',
      4: 'Donnerstag',
      5: 'Freitag',
      6: 'Samstag',
      7: 'Sonntag'
    }

    if (/^[0-7]$/.test(weekday)) {
      return `${names[weekday]} um ${time}`
    }
  }

  return null
}

function scheduleText(task) {
  if (task.scheduleKind === 'once') {
    return `Einmalig · ${
      formatIso(task.scheduleValue, task.timezone) ||
      task.scheduleValue
    }`
  }

  if (task.scheduleKind === 'interval') {
    const minutes = Number(task.scheduleValue)
    return Number.isFinite(minutes)
      ? `Alle ${minutes} ${minutes === 1 ? 'Minute' : 'Minuten'}`
      : `Intervall · ${task.scheduleValue}`
  }

  const readable = cronDescription(task.scheduleValue)
  return readable
    ? `${readable} · ${task.scheduleValue}`
    : `Cron · ${task.scheduleValue}`
}

function statusLabel(status) {
  if (status === 'success') return 'Erfolgreich'
  if (status === 'failed') return 'Fehlgeschlagen'
  if (status === 'running') return 'Läuft'
  return null
}

function taskToDraft(task) {
  return {
    title: task.title || '',
    prompt: task.prompt || '',
    taskType: task.type || 'reminder',
    scheduleKind: task.scheduleKind || 'once',
    scheduleValue: task.scheduleKind === 'once'
      ? toDateTimeLocal(task.scheduleValue)
      : String(task.scheduleValue || ''),
    timezone: task.timezone || 'Europe/Vienna',
    conversationTarget: task.conversationId
      ? String(task.conversationId)
      : 'auto',
    retentionDays: task.retentionDays == null
      ? ''
      : String(task.retentionDays),
    enabled: Boolean(task.enabled)
  }
}

function scheduleValueFromDraft(draft) {
  const scheduleValue = draft.scheduleKind === 'once'
    ? fromDateTimeLocal(draft.scheduleValue)
    : String(draft.scheduleValue || '').trim()

  if (!scheduleValue) {
    throw new Error('Bitte einen Zeitplan angeben.')
  }

  return scheduleValue
}

function retentionDaysFromDraft(draft) {
  const raw = String(draft.retentionDays ?? '').trim()

  if (!raw) return null

  const days = Number(raw)

  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error(
      'Aufbewahrung muss zwischen 1 und 3650 Tagen liegen.'
    )
  }

  return days
}

function conversationPayload(draft, templateConversationId) {
  if (draft.conversationTarget === 'auto') {
    return {
      conversationMode: 'auto',
      ...(templateConversationId
        ? { templateConversationId }
        : {})
    }
  }

  const conversationId = Number(draft.conversationTarget)

  if (!Number.isInteger(conversationId) || conversationId < 1) {
    throw new Error('Bitte eine gültige Ziel-Unterhaltung auswählen.')
  }

  return { conversationId }
}

function payloadFromDraft(draft, templateConversationId) {
  return {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    taskType: draft.taskType,
    scheduleKind: draft.scheduleKind,
    scheduleValue: scheduleValueFromDraft(draft),
    timezone:
      draft.timezone.trim() || 'Europe/Vienna',
    retentionDays: retentionDaysFromDraft(draft),
    enabled: Boolean(draft.enabled),
    ...conversationPayload(
      draft,
      templateConversationId
    )
  }
}

function payloadForEdit(draft, existing) {
  const payload = {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    taskType: draft.taskType,
    retentionDays: retentionDaysFromDraft(draft),
    enabled: Boolean(draft.enabled)
  }

  const timezone =
    draft.timezone.trim() || 'Europe/Vienna'
  const scheduleValue = scheduleValueFromDraft(draft)

  let valueChanged = false

  if (draft.scheduleKind === 'once') {
    valueChanged =
      new Date(scheduleValue).getTime() !==
      new Date(existing.scheduleValue).getTime()
  } else {
    valueChanged =
      scheduleValue !==
      String(existing.scheduleValue || '').trim()
  }

  if (
    draft.scheduleKind !== existing.scheduleKind ||
    timezone !== existing.timezone ||
    valueChanged
  ) {
    payload.scheduleKind = draft.scheduleKind
    payload.scheduleValue = scheduleValue
    payload.timezone = timezone
  }

  if (draft.conversationTarget === 'auto') {
    payload.conversationMode = 'auto'
    if (existing.conversationId) {
      payload.templateConversationId =
        existing.conversationId
    }
  } else {
    const selectedConversationId = Number(
      draft.conversationTarget
    )

    if (
      !Number.isInteger(selectedConversationId) ||
      selectedConversationId < 1
    ) {
      throw new Error(
        'Bitte eine gültige Ziel-Unterhaltung auswählen.'
      )
    }

    if (selectedConversationId !== existing.conversationId) {
      payload.conversationId = selectedConversationId
    }
  }

  return payload
}

function TaskEditor({
  value,
  onChange,
  onSave,
  onCancel,
  saving,
  conversations = [],
  createMode = false
}) {
  function set(name, nextValue) {
    onChange({
      ...value,
      [name]: nextValue
    })
  }

  const valid =
    value.title.trim() &&
    value.prompt.trim() &&
    String(value.scheduleValue || '').trim()

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10
        }}
      >
        <label>
          <div style={labelStyle()}>Typ</div>
          <select
            value={value.taskType}
            onChange={event =>
              set('taskType', event.target.value)
            }
            style={fieldStyle()}
          >
            {TYPE_OPTIONS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <div style={labelStyle()}>Zeitplan</div>
          <select
            value={value.scheduleKind}
            onChange={event =>
              set('scheduleKind', event.target.value)
            }
            style={fieldStyle()}
          >
            {SCHEDULE_OPTIONS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <div style={labelStyle()}>Zeitzone</div>
          <input
            value={value.timezone}
            onChange={event =>
              set('timezone', event.target.value)
            }
            placeholder="Europe/Vienna"
            style={fieldStyle()}
          />
        </label>
      </div>

      <label>
        <div style={labelStyle()}>Ziel-Unterhaltung</div>
        <select
          value={value.conversationTarget}
          onChange={event =>
            set('conversationTarget', event.target.value)
          }
          style={fieldStyle()}
        >
          <option value="auto">
            Automatisch: eigene Task-Unterhaltung
          </option>
          {conversations.map(conversation => (
            <option
              key={conversation.id}
              value={String(conversation.id)}
            >
              {conversation.title}
            </option>
          ))}
        </select>
        <div
          style={{
            marginTop: 5,
            color: 'var(--text3)',
            fontSize: 10
          }}
        >
          Bei „Automatisch“ wird eine dauerhafte eigene Unterhaltung für diesen Task angelegt.
        </div>
      </label>

      <label>
        <div style={labelStyle()}>
          Task-Nachrichten behalten (Tage)
        </div>
        <input
          type="number"
          min={1}
          max={3650}
          step={1}
          value={value.retentionDays}
          onChange={event =>
            set('retentionDays', event.target.value)
          }
          placeholder="Leer = unbegrenzt"
          style={fieldStyle()}
        />
        <div
          style={{
            marginTop: 5,
            color: 'var(--text3)',
            fontSize: 10
          }}
        >
          Löscht nur Nachrichten, die dieser Task selbst erzeugt hat. Andere Chat-Nachrichten bleiben erhalten.
        </div>
      </label>

      <label>
        <div style={labelStyle()}>Titel</div>
        <input
          value={value.title}
          onChange={event =>
            set('title', event.target.value)
          }
          placeholder="Zum Beispiel Morning Briefing"
          maxLength={160}
          style={fieldStyle()}
        />
      </label>

      <label>
        <div style={labelStyle()}>
          {value.taskType === 'agent'
            ? 'Agenten-Anweisung'
            : 'Erinnerungstext'}
        </div>
        <textarea
          value={value.prompt}
          onChange={event =>
            set('prompt', event.target.value)
          }
          rows={5}
          maxLength={20000}
          placeholder={
            value.taskType === 'agent'
              ? 'Was soll EchoLink beim Lauf frisch erzeugen?'
              : 'Welcher Text soll später angezeigt werden?'
          }
          style={{
            ...fieldStyle(),
            resize: 'vertical',
            lineHeight: 1.5
          }}
        />
      </label>

      <label>
        <div style={labelStyle()}>
          {value.scheduleKind === 'once'
            ? 'Zeitpunkt'
            : value.scheduleKind === 'interval'
              ? 'Intervall in Minuten'
              : 'Cron-Ausdruck'}
        </div>

        {value.scheduleKind === 'once' ? (
          <input
            type="datetime-local"
            value={value.scheduleValue}
            onChange={event =>
              set('scheduleValue', event.target.value)
            }
            style={fieldStyle()}
          />
        ) : (
          <input
            type={
              value.scheduleKind === 'interval'
                ? 'number'
                : 'text'
            }
            min={
              value.scheduleKind === 'interval'
                ? 1
                : undefined
            }
            step={
              value.scheduleKind === 'interval'
                ? 1
                : undefined
            }
            value={value.scheduleValue}
            onChange={event =>
              set('scheduleValue', event.target.value)
            }
            placeholder={
              value.scheduleKind === 'interval'
                ? '60'
                : '0 7 * * *'
            }
            style={fieldStyle()}
          />
        )}

        {value.scheduleKind === 'cron' && (
          <div
            style={{
              marginTop: 5,
              color: 'var(--text3)',
              fontSize: 10
            }}
          >
            Beispiel: <code>0 7 * * *</code> = täglich um 07:00 Uhr.
          </div>
        )}
      </label>

      {!createMode && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text2)',
            fontSize: 12
          }}
        >
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={event =>
              set('enabled', event.target.checked)
            }
          />
          Task aktiv
        </label>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          flexWrap: 'wrap'
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={buttonStyle({ disabled: saving })}
        >
          Abbrechen
        </button>

        <button
          type="button"
          onClick={onSave}
          disabled={saving || !valid}
          style={buttonStyle({
            accent: true,
            disabled: saving || !valid
          })}
        >
          {saving
            ? 'Speichere …'
            : createMode
              ? 'Task anlegen'
              : 'Speichern'}
        </button>
      </div>
    </div>
  )
}

export default function TaskPanel({
  conversationId,
  conversations = [],
  onConversationsChanged,
  onClose
}) {
  const [tasks, setTasks] = useState([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] =
    useState(emptyTask)
  const [editingId, setEditingId] =
    useState(null)
  const [editDraft, setEditDraft] =
    useState(null)
  const [actionId, setActionId] =
    useState(null)
  const [expandedRuns, setExpandedRuns] =
    useState(null)
  const [runs, setRuns] = useState([])
  const [runsLoading, setRunsLoading] =
    useState(false)

  async function loadTasks({ quiet = false } = {}) {
    if (!quiet) setLoading(true)
    setError('')

    try {
      const data = await api.get('/api/tasks')
      setTasks(Array.isArray(data) ? data : [])
    } catch (loadError) {
      setError(
        loadError?.message ||
        'Tasks konnten nicht geladen werden.'
      )
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  useEffect(() => {
    loadTasks()

    const timer = setInterval(
      () => loadTasks({ quiet: true }),
      30000
    )

    return () => clearInterval(timer)
  }, [])

  const visibleTasks = useMemo(() => {
    if (filter === 'active') {
      return tasks.filter(task => task.enabled)
    }

    if (filter === 'agent') {
      return tasks.filter(task => task.type === 'agent')
    }

    if (filter === 'reminder') {
      return tasks.filter(
        task => task.type === 'reminder'
      )
    }

    return tasks
  }, [filter, tasks])

  async function createTask() {
    setActionId('create')
    setError('')

    try {
      const payload = payloadFromDraft(
        createDraft,
        conversationId
      )

      await api.post('/api/tasks', payload)
      setCreating(false)
      setCreateDraft({ ...emptyTask })
      await loadTasks({ quiet: true })
      await onConversationsChanged?.()
    } catch (createError) {
      setError(
        createError?.message ||
        'Task konnte nicht angelegt werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  function startEdit(task) {
    setEditingId(task.id)
    setEditDraft(taskToDraft(task))
    setError('')
  }

  async function saveTask(taskId) {
    setActionId(taskId)
    setError('')

    try {
      const existing = tasks.find(
        task => task.id === taskId
      )

      if (!existing) {
        throw new Error('Task wurde nicht gefunden.')
      }

      const payload = payloadForEdit(
        editDraft,
        existing
      )

      await api.patch(
        `/api/tasks/${taskId}`,
        payload
      )

      setEditingId(null)
      setEditDraft(null)
      await loadTasks({ quiet: true })
      await onConversationsChanged?.()
    } catch (saveError) {
      setError(
        saveError?.message ||
        'Task konnte nicht gespeichert werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function toggleTask(task) {
    setActionId(task.id)
    setError('')

    try {
      await api.patch(
        `/api/tasks/${task.id}`,
        { enabled: !task.enabled }
      )
      await loadTasks({ quiet: true })
    } catch (toggleError) {
      setError(
        toggleError?.message ||
        'Task konnte nicht geändert werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function runNow(task) {
    const confirmed = window.confirm(
      `„${task.title}“ jetzt ausführen?`
    )

    if (!confirmed) return

    setActionId(task.id)
    setError('')

    try {
      await api.post(
        `/api/tasks/${task.id}/run-now`,
        {}
      )
      await loadTasks({ quiet: true })
    } catch (runError) {
      setError(
        runError?.message ||
        'Task konnte nicht gestartet werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function deleteTask(task) {
    const confirmed = window.confirm(
      `Task wirklich endgültig löschen?\n\n${task.title}`
    )

    if (!confirmed) return

    setActionId(task.id)
    setError('')

    try {
      await api.delete(`/api/tasks/${task.id}`)
      if (expandedRuns === task.id) {
        setExpandedRuns(null)
        setRuns([])
      }
      await loadTasks({ quiet: true })
    } catch (deleteError) {
      setError(
        deleteError?.message ||
        'Task konnte nicht gelöscht werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function toggleRuns(taskId) {
    if (expandedRuns === taskId) {
      setExpandedRuns(null)
      setRuns([])
      return
    }

    setExpandedRuns(taskId)
    setRunsLoading(true)
    setRuns([])

    try {
      const data = await api.get(
        `/api/tasks/${taskId}/runs`
      )
      setRuns(Array.isArray(data) ? data : [])
    } catch (runsError) {
      setError(
        runsError?.message ||
        'Task-Läufe konnten nicht geladen werden.'
      )
    } finally {
      setRunsLoading(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0,0,0,0.68)',
        backdropFilter: 'blur(3px)'
      }}
    >
      <section
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(900px, 100%)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          borderRadius: 14,
          background: 'var(--bg2)',
          boxShadow:
            '0 20px 60px rgba(0,0,0,0.55)'
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '13px 15px',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <div style={{ flex: 1 }}>
            <strong
              style={{
                color: 'var(--text1)',
                fontFamily: 'var(--font-mono)'
              }}
            >
              Geplante Aufgaben
            </strong>

            <div
              style={{
                marginTop: 3,
                color: 'var(--text3)',
                fontSize: 11
              }}
            >
              Erinnerungen, Agenten, Cronjobs und einmalige Tasks
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            style={{
              ...buttonStyle(),
              width: 34,
              padding: 0,
              fontSize: 20
            }}
          >
            ×
          </button>
        </header>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            padding: '10px 15px',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <select
            value={filter}
            onChange={event =>
              setFilter(event.target.value)
            }
            style={{
              ...fieldStyle(),
              width: 'auto'
            }}
          >
            <option value="all">Alle Tasks</option>
            <option value="active">Nur aktive</option>
            <option value="agent">Nur Agenten</option>
            <option value="reminder">
              Nur Erinnerungen
            </option>
          </select>

          <button
            type="button"
            onClick={() => loadTasks()}
            disabled={loading}
            style={buttonStyle({ disabled: loading })}
          >
            Neu laden
          </button>

          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={creating}
            title="Neue Aufgabe anlegen"
            style={{
              ...buttonStyle({
                accent: true,
                disabled: creating
              }),
              marginLeft: 'auto'
            }}
          >
            Neue Aufgabe
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 260,
            overflowY: 'auto',
            padding: 15
          }}
        >
          {error && (
            <div
              style={{
                marginBottom: 12,
                padding: '9px 11px',
                border: '1px solid var(--danger)',
                borderRadius: 8,
                color: 'var(--danger)',
                fontSize: 12
              }}
            >
              {error}
            </div>
          )}

          {creating && (
            <div
              style={{
                marginBottom: 14,
                padding: 13,
                border: '1px solid var(--accent)',
                borderRadius: 10,
                background: 'var(--bg1)'
              }}
            >
              <TaskEditor
                value={createDraft}
                onChange={setCreateDraft}
                onSave={createTask}
                onCancel={() => {
                  setCreating(false)
                  setCreateDraft({ ...emptyTask })
                }}
                saving={actionId === 'create'}
                conversations={conversations}
                createMode
              />
            </div>
          )}

          {loading ? (
            <div style={{ color: 'var(--text3)' }}>
              Tasks werden geladen …
            </div>
          ) : visibleTasks.length === 0 ? (
            <div
              style={{
                padding: '28px 8px',
                textAlign: 'center',
                color: 'var(--text3)',
                fontSize: 13
              }}
            >
              Keine passenden Tasks vorhanden.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {visibleTasks.map(task => {
                const busy = actionId === task.id
                const completedOnce =
                  task.scheduleKind === 'once' &&
                  !task.enabled &&
                  Boolean(task.lastRunAt)

                return (
                  <article
                    key={task.id}
                    style={{
                      padding: 13,
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      background: 'var(--bg1)',
                      opacity: task.enabled ? 1 : 0.72
                    }}
                  >
                    {editingId === task.id ? (
                      <TaskEditor
                        value={editDraft}
                        onChange={setEditDraft}
                        onSave={() => saveTask(task.id)}
                        onCancel={() => {
                          setEditingId(null)
                          setEditDraft(null)
                        }}
                        saving={busy}
                        conversations={conversations}
                      />
                    ) : (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 10
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                flexWrap: 'wrap',
                                gap: 6
                              }}
                            >
                              <strong
                                style={{
                                  color: 'var(--text1)',
                                  fontSize: 13
                                }}
                              >
                                {task.title}
                              </strong>

                              <span
                                style={badgeStyle({
                                  accent: task.type === 'agent'
                                })}
                              >
                                {task.type === 'agent'
                                  ? 'Agent'
                                  : 'Erinnerung'}
                              </span>

                              <span style={badgeStyle()}>
                                {task.scheduleKind === 'once'
                                  ? 'Einmalig'
                                  : task.scheduleKind === 'interval'
                                    ? 'Intervall'
                                    : 'Cron'}
                              </span>

                              <span
                                style={badgeStyle({
                                  accent: task.enabled,
                                  muted: !task.enabled
                                })}
                              >
                                {task.enabled
                                  ? 'Aktiv'
                                  : completedOnce
                                    ? 'Erledigt'
                                    : 'Inaktiv'}
                              </span>
                            </div>

                            <div
                              style={{
                                marginTop: 7,
                                color: 'var(--text2)',
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11,
                                lineHeight: 1.5,
                                overflowWrap: 'anywhere'
                              }}
                            >
                              {scheduleText(task)} · {task.timezone}
                            </div>

                            <div
                              style={{
                                marginTop: 4,
                                color: 'var(--text3)',
                                fontSize: 11
                              }}
                            >
                              Ziel: {task.conversationTitle ||
                                `Unterhaltung #${task.conversationId || '–'}`}
                              {' · '}Aufbewahrung: {task.retentionDays
                                ? `${task.retentionDays} Tage`
                                : 'unbegrenzt'}
                            </div>

                            <div
                              style={{
                                marginTop: 4,
                                color: 'var(--text3)',
                                fontSize: 11,
                                lineHeight: 1.5
                              }}
                            >
                              {task.nextRunAt
                                ? `Nächster Lauf: ${formatUnix(task.nextRunAt, task.timezone)}`
                                : 'Kein nächster Lauf geplant'}
                              {task.lastRunAt
                                ? ` · Letzter Lauf: ${formatUnix(task.lastRunAt, task.timezone)}`
                                : ''}
                            </div>

                            {task.lastRunStatus && (
                              <div
                                style={{
                                  marginTop: 4,
                                  color: task.lastRunStatus === 'failed'
                                    ? 'var(--danger)'
                                    : 'var(--text3)',
                                  fontSize: 11
                                }}
                              >
                                Letzter Status: {statusLabel(task.lastRunStatus)}
                                {task.lastRunError
                                  ? ` · ${task.lastRunError}`
                                  : ''}
                              </div>
                            )}
                          </div>
                        </div>

                        <div
                          style={{
                            marginTop: 10,
                            padding: '9px 10px',
                            borderRadius: 8,
                            background: 'var(--bg3)',
                            color: 'var(--text2)',
                            fontSize: 12,
                            lineHeight: 1.5,
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere'
                          }}
                        >
                          {task.prompt}
                        </div>

                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 7,
                            marginTop: 10
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => startEdit(task)}
                            disabled={busy}
                            style={buttonStyle({ disabled: busy })}
                          >
                            Bearbeiten
                          </button>

                          {!completedOnce && (
                            <button
                              type="button"
                              onClick={() => toggleTask(task)}
                              disabled={busy}
                              style={buttonStyle({ disabled: busy })}
                            >
                              {task.enabled
                                ? 'Deaktivieren'
                                : 'Aktivieren'}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => runNow(task)}
                            disabled={busy}
                            style={buttonStyle({
                              accent: true,
                              disabled: busy
                            })}
                          >
                            Jetzt ausführen
                          </button>

                          <button
                            type="button"
                            onClick={() => toggleRuns(task.id)}
                            disabled={runsLoading && expandedRuns === task.id}
                            style={buttonStyle({
                              disabled:
                                runsLoading &&
                                expandedRuns === task.id
                            })}
                          >
                            {expandedRuns === task.id
                              ? 'Läufe schließen'
                              : 'Läufe'}
                          </button>

                          <button
                            type="button"
                            onClick={() => deleteTask(task)}
                            disabled={busy}
                            style={{
                              ...buttonStyle({
                                danger: true,
                                disabled: busy
                              }),
                              marginLeft: 'auto'
                            }}
                          >
                            Löschen
                          </button>
                        </div>

                        {expandedRuns === task.id && (
                          <div
                            style={{
                              marginTop: 11,
                              paddingTop: 10,
                              borderTop: '1px solid var(--border)'
                            }}
                          >
                            {runsLoading ? (
                              <div style={{ color: 'var(--text3)', fontSize: 12 }}>
                                Läufe werden geladen …
                              </div>
                            ) : runs.length === 0 ? (
                              <div style={{ color: 'var(--text3)', fontSize: 12 }}>
                                Noch keine Läufe vorhanden.
                              </div>
                            ) : (
                              <div style={{ display: 'grid', gap: 7 }}>
                                {runs.slice(0, 10).map(run => (
                                  <div
                                    key={run.id}
                                    style={{
                                      padding: '8px 9px',
                                      borderRadius: 8,
                                      background: 'var(--bg3)',
                                      color: 'var(--text2)',
                                      fontSize: 11,
                                      lineHeight: 1.45
                                    }}
                                  >
                                    <strong
                                      style={{
                                        color: run.status === 'failed'
                                          ? 'var(--danger)'
                                          : 'var(--text1)'
                                      }}
                                    >
                                      {statusLabel(run.status) || run.status}
                                    </strong>
                                    {' · '}
                                    {formatUnix(run.startedAt, task.timezone)}
                                    {run.finishedAt
                                      ? ` – ${formatUnix(run.finishedAt, task.timezone)}`
                                      : ''}
                                    {run.error && (
                                      <div
                                        style={{
                                          marginTop: 4,
                                          color: 'var(--danger)',
                                          whiteSpace: 'pre-wrap'
                                        }}
                                      >
                                        {run.error}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
