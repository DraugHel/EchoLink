import {
  useEffect,
  useState
} from 'react'

import api from '../lib/api.js'

const REMINDERS = [
  { value: 'default', label: 'Kalenderstandard' },
  { value: -1, label: 'Keine Erinnerung' },
  { value: 0, label: 'Zum Schichtbeginn' },
  { value: 15, label: '15 Minuten vorher' },
  { value: 30, label: '30 Minuten vorher' },
  { value: 60, label: '1 Stunde vorher' },
  { value: 120, label: '2 Stunden vorher' },
  { value: 360, label: '6 Stunden vorher' },
  { value: 720, label: '12 Stunden vorher' },
  { value: 1440, label: '1 Tag vorher' }
]

export default function ShiftSettings({
  profile,
  onSaved,
  onClose
}) {
  const [form, setForm] = useState(profile)
  const [calendars, setCalendars] = useState([])
  const [loadingCalendars, setLoadingCalendars] =
    useState(true)
  const [saving, setSaving] = useState(false)
  const [removingReminders, setRemovingReminders] =
    useState(false)
  const [reminderResult, setReminderResult] =
    useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setForm(profile)
  }, [profile])

  useEffect(() => {
    let alive = true

    api.get('/api/shift-settings/calendars')
      .then(data => {
        if (alive) {
          setCalendars(data.calendars || [])
        }
      })
      .catch(failure => {
        if (alive) {
          setError(
            failure?.message ||
            'Kalender konnten nicht geladen werden'
          )
        }
      })
      .finally(() => {
        if (alive) setLoadingCalendars(false)
      })

    return () => {
      alive = false
    }
  }, [])

  if (!form) return null

  function update(field, value) {
    setForm(previous => ({
      ...previous,
      [field]: value
    }))
  }

  function updateCode(code, field, value) {
    setForm(previous => ({
      ...previous,
      codes: {
        ...previous.codes,
        [code]: {
          ...previous.codes[code],
          [field]: value
        }
      }
    }))
  }

  function changeCalendar(calendarId) {
    const calendar = calendars.find(
      item => item.id === calendarId
    )

    setForm(previous => ({
      ...previous,
      calendarId,
      calendarName:
        calendar?.name ||
        previous.calendarName ||
        'Kalender'
    }))
  }

  async function save() {
    setSaving(true)
    setError('')

    try {
      const saved = await api.put(
        '/api/shift-settings',
        form
      )

      onSaved(saved)
    } catch (failure) {
      setError(
        failure?.message ||
        'Schichtprofil konnte nicht gespeichert werden'
      )
    } finally {
      setSaving(false)
    }
  }


  async function removeExistingReminders() {
    const accepted = window.confirm(
      'Erinnerungen bei allen von EchoLink verwalteten Schichten entfernen? Titel, Zeiten und sonstige Kalenderdaten bleiben unverändert.'
    )

    if (!accepted) return

    setRemovingReminders(true)
    setReminderResult(null)
    setError('')

    try {
      const result = await api.post(
        '/api/shift-settings/remove-reminders',
        {}
      )

      setReminderResult(
        result.summary || null
      )
    } catch (failure) {
      setError(
        failure?.message ||
        'Erinnerungen konnten nicht entfernt werden'
      )
    } finally {
      setRemovingReminders(false)
    }
  }

  return (
    <section style={styles.card}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>
            Schichtprofil
          </h3>
          <div style={styles.subtitle}>
            Zeiten, Kalender und Erinnerung dauerhaft speichern.
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={styles.close}
        >
          Schließen
        </button>
      </div>

      <div style={styles.grid}>
        <label style={styles.label}>
          Zielkalender
          <select
            value={form.calendarId}
            onChange={event =>
              changeCalendar(event.target.value)
            }
            style={styles.input}
            disabled={loadingCalendars}
          >
            {calendars.length === 0 && (
              <option value={form.calendarId}>
                {loadingCalendars
                  ? 'Kalender werden geladen …'
                  : form.calendarName || 'Primärkalender'}
              </option>
            )}

            {calendars.map(calendar => (
              <option
                key={calendar.id}
                value={calendar.id}
              >
                {calendar.name}
                {calendar.primary ? ' · primär' : ''}
              </option>
            ))}
          </select>
        </label>

        <label style={styles.label}>
          Erinnerung
          <select
            value={
              form.reminderMinutes == null
                ? 'default'
                : form.reminderMinutes
            }
            onChange={event =>
              update(
                'reminderMinutes',
                event.target.value === 'default'
                  ? null
                  : Number(event.target.value)
              )
            }
            style={styles.input}
          >
            {REMINDERS.map(option => (
              <option
                key={option.value}
                value={option.value}
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label style={styles.label}>
          Ort
          <input
            type="text"
            value={form.location || ''}
            onChange={event =>
              update('location', event.target.value)
            }
            placeholder="Optional"
            style={styles.input}
          />
        </label>

        <label style={styles.label}>
          Zusätzliche Beschreibung
          <input
            type="text"
            value={form.description || ''}
            onChange={event =>
              update('description', event.target.value)
            }
            placeholder="Optional"
            style={styles.input}
          />
        </label>
      </div>

      <div style={styles.codeList}>
        {['1', '2', '3'].map(code => (
          <div key={code} style={styles.codeRow}>
            <strong style={styles.codeBadge}>
              {code}
            </strong>

            <input
              type="text"
              value={form.codes[code].title}
              onChange={event =>
                updateCode(
                  code,
                  'title',
                  event.target.value
                )
              }
              aria-label={`Titel Code ${code}`}
              style={{
                ...styles.input,
                flex: '1 1 150px'
              }}
            />

            <input
              type="time"
              value={form.codes[code].startTime}
              onChange={event =>
                updateCode(
                  code,
                  'startTime',
                  event.target.value
                )
              }
              aria-label={`Beginn Code ${code}`}
              style={styles.timeInput}
            />

            <span style={styles.arrow}>–</span>

            <input
              type="time"
              value={form.codes[code].endTime}
              onChange={event =>
                updateCode(
                  code,
                  'endTime',
                  event.target.value
                )
              }
              aria-label={`Ende Code ${code}`}
              style={styles.timeInput}
            />
          </div>
        ))}
      </div>


      {form.reminderMinutes === -1 && (
        <div style={styles.reminderCleanup}>
          <div style={styles.reminderCleanupText}>
            <strong>
              Bereits importierte Schichten
            </strong>

            <div style={styles.subtitle}>
              Die Profileinstellung gilt automatisch für neue
              oder erneut synchronisierte Termine. Mit diesem
              Button wird die Erinnerung zusätzlich bei allen
              schon vorhandenen EchoLink-Schichten entfernt.
            </div>
          </div>

          <button
            type="button"
            onClick={removeExistingReminders}
            disabled={
              removingReminders ||
              saving
            }
            style={{
              ...styles.cleanupButton,
              opacity:
                removingReminders ||
                saving
                  ? 0.55
                  : 1
            }}
          >
            {removingReminders
              ? 'Erinnerungen werden entfernt …'
              : 'Bestehende Erinnerungen entfernen'}
          </button>
        </div>
      )}

      {reminderResult && (
        <div style={styles.success}>
          {reminderResult.updated} Erinnerungen entfernt
          {' · '}
          {reminderResult.alreadyRemoved} waren bereits aus
          {' · '}
          {reminderResult.missing} Termine nicht mehr vorhanden
          {' · '}
          {reminderResult.errors} Fehler
        </div>
      )}

      {error && (
        <div style={styles.error}>{error}</div>
      )}

      <div style={styles.footer}>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            ...styles.save,
            opacity: saving ? 0.55 : 1
          }}
        >
          {saving
            ? 'Speichert …'
            : 'Profil speichern'}
        </button>
      </div>
    </section>
  )
}

const styles = {
  card: {
    marginBottom: 14,
    padding: 14,
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--bg3)'
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14
  },
  title: {
    margin: 0,
    color: 'var(--text)',
    fontSize: 15
  },
  subtitle: {
    marginTop: 4,
    color: 'var(--text3)',
    fontSize: 10,
    lineHeight: 1.4
  },
  close: {
    flexShrink: 0,
    padding: '7px 9px',
    border: '1px solid var(--border)',
    borderRadius: 7,
    background: 'var(--bg2)',
    color: 'var(--text2)',
    fontSize: 11
  },
  grid: {
    display: 'grid',
    gridTemplateColumns:
      'repeat(auto-fit, minmax(190px, 1fr))',
    gap: 10
  },
  label: {
    minWidth: 0,
    display: 'grid',
    gap: 6,
    color: 'var(--text2)',
    fontSize: 11,
    fontWeight: 600
  },
  input: {
    width: '100%',
    minWidth: 0,
    padding: '8px 9px',
    boxSizing: 'border-box',
    border: '1px solid var(--border)',
    borderRadius: 7,
    background: 'var(--bg2)',
    color: 'var(--text)',
    fontSize: 12
  },
  codeList: {
    display: 'grid',
    gap: 8,
    marginTop: 14
  },
  codeRow: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7
  },
  codeBadge: {
    width: 28,
    height: 28,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 7,
    background: 'var(--bg2)',
    color: 'var(--accent)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12
  },
  timeInput: {
    width: 105,
    maxWidth: '100%',
    padding: '8px 7px',
    boxSizing: 'border-box',
    border: '1px solid var(--border)',
    borderRadius: 7,
    background: 'var(--bg2)',
    color: 'var(--text)',
    fontSize: 12
  },
  arrow: {
    color: 'var(--text3)'
  },
  error: {
    marginTop: 10,
    padding: 9,
    border: '1px solid rgba(255,80,80,0.3)',
    borderRadius: 8,
    background: 'rgba(255,80,80,0.08)',
    color: 'var(--danger)',
    fontSize: 11
  },
  reminderCleanup: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
    padding: 11,
    border: '1px solid var(--border)',
    borderRadius: 9,
    background: 'var(--bg2)'
  },
  reminderCleanupText: {
    minWidth: 0,
    flex: '1 1 260px',
    color: 'var(--text2)',
    fontSize: 11,
    lineHeight: 1.45
  },
  cleanupButton: {
    flex: '0 1 auto',
    maxWidth: '100%',
    padding: '9px 11px',
    boxSizing: 'border-box',
    border: '1px solid rgba(255,180,80,0.35)',
    borderRadius: 8,
    background: 'rgba(255,180,80,0.08)',
    color: 'var(--text)',
    fontSize: 11,
    fontWeight: 600
  },
  success: {
    marginTop: 10,
    padding: 10,
    border: '1px solid var(--green-dim)',
    borderRadius: 9,
    background: 'var(--green-bg)',
    color: 'var(--green)',
    fontSize: 11,
    lineHeight: 1.45
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: 12
  },
  save: {
    padding: '9px 12px',
    borderRadius: 8,
    background: 'var(--accent)',
    color: '#0d0d0d',
    fontWeight: 700,
    fontSize: 12
  }
}
