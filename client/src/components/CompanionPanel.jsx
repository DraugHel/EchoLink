import { useCallback, useEffect, useState } from 'react'
import api from '../lib/api.js'

const EDITABLE_KEYS = [
  'minPerDay',
  'maxPerDay',
  'windowStart',
  'windowEnd',
  'minGapMinutes',
  'maxUnanswered',
  'model',
  'tone',
  'rules',
  'intro',
  'pushPreview',
  'sources'
]

const SOURCE_OPTIONS = [
  ['memory', 'Memory', 'Eine zufällige Auswahl deiner wichtigen Erinnerungen'],
  ['shifts', 'Schichtplan', 'Deine nächsten Schichten'],
  ['calendar', 'Kalender', 'Termine heute und morgen'],
  ['mail', 'Mail', 'Nur Absender und Betreff ungelesener Mails, nie der Text'],
  ['server', 'Serverstatus', 'Speicher und offene Vorfälle']
]

const GAP_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 360]

const EVENT_LABELS = {
  sent: 'Gesendet',
  skipped: 'Geschwiegen',
  missed: 'Verpasst',
  paused: 'Pausiert',
  planned: 'Plan',
  error: 'Fehler',
  test: 'Vorschau'
}

export function pickEditable(settings, defaults) {
  const draft = {}

  for (const key of EDITABLE_KEYS) {
    draft[key] =
      key === 'sources'
        ? { ...settings.sources }
        : settings[key]
  }

  // Leer gespeichert heisst "Standardregeln": Im Feld steht dann der Standardtext.
  draft.rules = settings.rules || defaults?.rules || ''
  draft.intro = settings.intro || defaults?.intro || ''

  return draft
}

// Entspricht der Text dem Standard (Regeln oder Beschreibung), wird "leer"
// gespeichert, damit spaetere Verbesserungen automatisch gelten.
export function normalizeRules(rules, defaultRules) {
  const text = String(rules ?? '').trim()

  return text === String(defaultRules ?? '').trim() ? '' : text
}

function sameDraft(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function formatClock(seconds, timeZone) {
  try {
    return new Date(seconds * 1000).toLocaleTimeString('de-AT', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone
    })
  } catch {
    return '–'
  }
}

function formatStamp(seconds) {
  return new Date(seconds * 1000).toLocaleString('de-AT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function statusLabel(settings) {
  if (!settings.enabled) return 'Aus'
  if (settings.muted) return 'Stumm'
  return 'Aktiv'
}

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        ...styles.switchTrack,
        background: checked ? 'var(--accent)' : 'var(--bg2)',
        opacity: disabled ? 0.5 : 1
      }}
    >
      <span
        style={{
          ...styles.switchKnob,
          transform: checked ? 'translateX(20px)' : 'translateX(0)'
        }}
      />
    </button>
  )
}

function Section({ title, children }) {
  return (
    <>
      <div style={styles.sectionTitle}>{title}</div>
      <div style={styles.card}>{children}</div>
    </>
  )
}

export function CompanionPanelView({
  data,
  draft,
  setDraft,
  dirty,
  busy,
  models,
  preview,
  notice,
  error,
  onClose,
  onToggleEnabled,
  onToggleMuted,
  onSave,
  onReset,
  onPreview,
  onSendNow,
  onReplan,
  onOpenChat
}) {
  const settings = data?.settings
  const status = data?.status
  const events = data?.events || []
  const defaults = data?.defaults
  const rulesAreDefault =
    normalizeRules(draft?.rules, defaults?.rules) === ''
  const introIsDefault =
    normalizeRules(draft?.intro, defaults?.intro) === ''

  let localToday = ''

  try {
    localToday = new Date().toLocaleDateString('sv-SE', {
      timeZone: settings?.timezone
    })
  } catch {
    localToday = ''
  }

  const hasTodayPlan =
    Boolean(status?.planDate) && status.planDate === localToday

  const updateDraft = patch =>
    setDraft(current => ({ ...current, ...patch }))

  return (
    <div
      className="echolink-fullscreen-overlay"
      onClick={onClose}
      style={styles.overlay}
    >
      <section
        className="echolink-fullscreen-panel"
        onClick={event => event.stopPropagation()}
        style={styles.panel}
      >
        <header style={styles.header}>
          <div style={styles.headerText}>
            <strong style={styles.title}>Luna</strong>
            <span style={styles.subtitle}>
              Meldet sich von sich aus bei dir
            </span>
          </div>

          {settings && (
            <span
              style={{
                ...styles.health,
                color:
                  settings.enabled && !settings.muted
                    ? 'var(--accent)'
                    : 'var(--text3)'
              }}
            >
              {statusLabel(settings)}
            </span>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            style={styles.close}
          >
            ×
          </button>
        </header>

        <div style={styles.body}>
          {!data && !error && (
            <div style={styles.empty}>Wird geladen …</div>
          )}

          {error && (
            <div style={styles.errorBox} role="alert">
              {error}
            </div>
          )}

          {notice && <div style={styles.noticeBox}>{notice}</div>}

          {settings && draft && (
            <>
              <Section title="Status">
                <div style={styles.row}>
                  <div style={styles.rowText}>
                    <strong style={styles.rowTitle}>
                      Luna darf mir schreiben
                    </strong>
                    <span style={styles.rowHint}>
                      Standardmäßig aus. Beim ersten Einschalten
                      entsteht der Chat „Luna“.
                    </span>
                  </div>
                  <Toggle
                    checked={settings.enabled}
                    onChange={onToggleEnabled}
                    disabled={busy}
                    label="Luna darf mir schreiben"
                  />
                </div>

                <label style={styles.row}>
                  <div style={styles.rowText}>
                    <strong style={styles.rowTitle}>Stumm</strong>
                    <span style={styles.rowHint}>
                      Solange der Haken gesetzt ist, schreibt Luna nichts.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.muted}
                    disabled={busy}
                    onChange={event =>
                      onToggleMuted(event.target.checked)
                    }
                    style={styles.checkbox}
                  />
                </label>

                <div style={styles.statusLines}>
                  {hasTodayPlan && status.planned.length > 0 ? (
                    <>
                      <span>
                        Heute gesendet: {status.sentToday} · noch offen:{' '}
                        {status.planned.filter(slot => !slot.done).length}
                      </span>
                      <span style={styles.chips}>
                        {status.planned.map(slot => (
                          <span
                            key={slot.at}
                            style={{
                              ...styles.chip,
                              opacity: slot.done ? 0.55 : 1
                            }}
                          >
                            {formatClock(slot.at, settings.timezone)}
                            {slot.done ? ' ✓' : ''}
                          </span>
                        ))}
                      </span>
                    </>
                  ) : hasTodayPlan ? (
                    <span>
                      Heute gesendet: {status.sentToday}. Für den Rest
                      des Tages ist keine Meldung geplant.
                    </span>
                  ) : (
                    <span>
                      Noch kein Plan für heute. Er entsteht beim ersten
                      Check innerhalb des Zeitfensters.
                    </span>
                  )}

                  {status.unanswered > 0 && (
                    <span>
                      Unbeantwortet: {status.unanswered} von höchstens{' '}
                      {settings.maxUnanswered}
                    </span>
                  )}

                  {!status.pushConfigured && (
                    <span style={{ color: 'var(--danger)' }}>
                      Web-Push ist auf dem Server nicht konfiguriert.
                      Nachrichten erscheinen nur im Chat.
                    </span>
                  )}
                </div>

                <div style={styles.buttonRow}>
                  <button
                    type="button"
                    onClick={onOpenChat}
                    disabled={!status.conversationId || busy}
                    style={styles.button}
                  >
                    Chat öffnen
                  </button>

                  <button
                    type="button"
                    onClick={onSendNow}
                    disabled={busy || settings.muted}
                    style={styles.button}
                  >
                    Jetzt eine Nachricht
                  </button>

                  <button
                    type="button"
                    onClick={onReplan}
                    disabled={
                      busy || !settings.enabled || settings.muted
                    }
                    style={styles.button}
                  >
                    Plan neu würfeln
                  </button>
                </div>
              </Section>

              <Section title="Häufigkeit und Zeiten">
                <div style={styles.formGrid}>
                  <label style={styles.field}>
                    <span style={styles.fieldLabel}>Mindestens pro Tag</span>
                    <select
                      value={draft.minPerDay}
                      onChange={event =>
                        updateDraft({
                          minPerDay: Number(event.target.value)
                        })
                      }
                      style={styles.input}
                    >
                      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={styles.field}>
                    <span style={styles.fieldLabel}>Höchstens pro Tag</span>
                    <select
                      value={draft.maxPerDay}
                      onChange={event =>
                        updateDraft({
                          maxPerDay: Number(event.target.value)
                        })
                      }
                      style={styles.input}
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8].map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={styles.field}>
                    <span style={styles.fieldLabel}>Zeitfenster von</span>
                    <input
                      type="time"
                      value={draft.windowStart}
                      onChange={event =>
                        updateDraft({ windowStart: event.target.value })
                      }
                      style={styles.input}
                    />
                  </label>

                  <label style={styles.field}>
                    <span style={styles.fieldLabel}>Zeitfenster bis</span>
                    <input
                      type="time"
                      value={draft.windowEnd}
                      onChange={event =>
                        updateDraft({ windowEnd: event.target.value })
                      }
                      style={styles.input}
                    />
                  </label>

                  <label style={styles.field}>
                    <span style={styles.fieldLabel}>Mindestabstand</span>
                    <select
                      value={draft.minGapMinutes}
                      onChange={event =>
                        updateDraft({
                          minGapMinutes: Number(event.target.value)
                        })
                      }
                      style={styles.input}
                    >
                      {GAP_OPTIONS.map(value => (
                        <option key={value} value={value}>
                          {value} Min.
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={styles.field}>
                    <span style={styles.fieldLabel}>
                      Unbeantwortet in Folge
                    </span>
                    <select
                      value={draft.maxUnanswered}
                      onChange={event =>
                        updateDraft({
                          maxUnanswered: Number(event.target.value)
                        })
                      }
                      style={styles.input}
                    >
                      {[1, 2, 3, 4, 5, 8, 10].map(value => (
                        <option key={value} value={value}>
                          höchstens {value}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <span style={styles.rowHint}>
                  Luna würfelt morgens, wie oft sie sich meldet, und verteilt
                  die Zeitpunkte zufällig im Fenster. Tagsüber schreibt sie
                  immer, auch bei Schicht und Terminen. Sobald du irgendwo
                  schreibst, zählt „unbeantwortet“ wieder bei null.
                </span>
              </Section>

              <Section title="Was Luna über dich sehen darf">
                {SOURCE_OPTIONS.map(([key, label, hint]) => (
                  <label key={key} style={styles.row}>
                    <div style={styles.rowText}>
                      <strong style={styles.rowTitle}>{label}</strong>
                      <span style={styles.rowHint}>{hint}</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={Boolean(draft.sources[key])}
                      onChange={event =>
                        updateDraft({
                          sources: {
                            ...draft.sources,
                            [key]: event.target.checked
                          }
                        })
                      }
                      style={styles.checkbox}
                    />
                  </label>
                ))}
                <span style={styles.rowHint}>
                  Was hier angehakt ist, geht bei jeder Meldung an das
                  gewählte Modell.
                </span>
              </Section>

              <Section title="Wer Luna ist">
                <span style={styles.rowHint}>
                  Wer Luna ist. Gilt für ihre Meldungen und für deine
                  Antworten im Chat „Luna“, damit sie überall derselbe
                  Charakter bleibt.
                  {introIsDefault
                    ? ' Aktuell gilt der Standardtext.'
                    : ' Aktuell gilt dein eigener Text.'}
                </span>

                <textarea
                  value={draft.intro}
                  maxLength={1000}
                  rows={3}
                  onChange={event =>
                    updateDraft({ intro: event.target.value })
                  }
                  style={{
                    ...styles.input,
                    ...styles.rulesInput
                  }}
                  aria-label="Wer Luna ist"
                />

                <div style={styles.buttonRow}>
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft({ intro: defaults?.intro || '' })
                    }
                    disabled={busy || introIsDefault || !defaults}
                    style={styles.button}
                  >
                    Standard wiederherstellen
                  </button>
                </div>
              </Section>

              <Section title="Regeln für Luna">
                <span style={styles.rowHint}>
                  So lautet der Auftrag an das Modell bei jeder Meldung.
                  {rulesAreDefault
                    ? ' Aktuell gelten die Standardregeln.'
                    : ' Aktuell gelten deine eigenen Regeln.'}
                </span>

                <textarea
                  value={draft.rules}
                  maxLength={4000}
                  rows={10}
                  onChange={event =>
                    updateDraft({ rules: event.target.value })
                  }
                  style={{
                    ...styles.input,
                    ...styles.rulesInput
                  }}
                  aria-label="Regeln für Luna"
                />

                <div style={styles.buttonRow}>
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft({ rules: defaults?.rules || '' })
                    }
                    disabled={busy || rulesAreDefault || !defaults}
                    style={styles.button}
                  >
                    Standard wiederherstellen
                  </button>
                </div>

                <span style={styles.rowHint}>
                  Luna meldet sich immer: Antwortet das Modell trotzdem
                  mit SKIP, fragt EchoLink einmal nach. Das lässt sich
                  über diesen Text nicht abschalten.
                </span>

                {defaults?.fixedRules && (
                  <details style={styles.details}>
                    <summary style={styles.summary}>
                      Immer aktiv (nicht änderbar)
                    </summary>
                    <pre style={styles.pre}>{defaults.fixedRules}</pre>
                  </details>
                )}
              </Section>

              <Section title="Ton und Modell">
                <label style={styles.field}>
                  <span style={styles.fieldLabel}>
                    Wie Luna schreibt (Meldungen und Chat)
                  </span>
                  <textarea
                    value={draft.tone}
                    maxLength={4000}
                    rows={4}
                    placeholder="Leer = kurz, trocken, freundlich. Wie ein Freund, der sich einfach meldet."
                    onChange={event =>
                      updateDraft({ tone: event.target.value })
                    }
                    style={{ ...styles.input, resize: 'vertical' }}
                  />
                </label>

                <label style={styles.field}>
                  <span style={styles.fieldLabel}>Modell</span>
                  <select
                    value={draft.model}
                    onChange={event =>
                      updateDraft({ model: event.target.value })
                    }
                    style={styles.input}
                  >
                    <option value="">
                      Standard (Modell des Chats „Luna“)
                    </option>
                    {draft.model &&
                      !models.includes(draft.model) && (
                        <option value={draft.model}>
                          {draft.model}
                        </option>
                      )}
                    {models.map(name => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={styles.row}>
                  <div style={styles.rowText}>
                    <strong style={styles.rowTitle}>
                      Nachricht in der Push-Vorschau zeigen
                    </strong>
                    <span style={styles.rowHint}>
                      Aus: Auf dem Sperrbildschirm steht nur „Luna hat dir
                      geschrieben“.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={draft.pushPreview}
                    onChange={event =>
                      updateDraft({ pushPreview: event.target.checked })
                    }
                    style={styles.checkbox}
                  />
                </label>
              </Section>

              <div style={styles.saveBar}>
                <button
                  type="button"
                  onClick={onReset}
                  disabled={!dirty || busy}
                  style={styles.button}
                >
                  Zurücksetzen
                </button>
                <button
                  type="button"
                  onClick={onSave}
                  disabled={!dirty || busy}
                  style={{
                    ...styles.button,
                    ...(dirty ? styles.buttonPrimary : {})
                  }}
                >
                  Speichern
                </button>
              </div>

              <Section title="Vorschau">
                <span style={styles.rowHint}>
                  Zeigt, was Luna jetzt sehen würde und was sie schreiben
                  würde. Es wird nichts gesendet. Kostet einen
                  Modellaufruf.
                </span>

                <button
                  type="button"
                  onClick={onPreview}
                  disabled={busy || dirty}
                  style={styles.button}
                >
                  {dirty
                    ? 'Erst speichern, dann Vorschau'
                    : 'Vorschau erzeugen'}
                </button>

                {preview && (
                  <>
                    <div style={styles.bubble}>
                      {preview.skipped
                        ? 'Luna würde diesmal schweigen.'
                        : preview.message}
                    </div>
                    <span style={styles.rowHint}>
                      Modell: {preview.model}
                    </span>
                    <details style={styles.details}>
                      <summary style={styles.summary}>
                        Das sieht Luna
                      </summary>
                      <pre style={styles.pre}>{preview.context}</pre>
                    </details>
                    {preview.chatPrompt && (
                      <details style={styles.details}>
                        <summary style={styles.summary}>
                          Auftrag im Chat „Luna“ (deine Antworten)
                        </summary>
                        <pre style={styles.pre}>
                          {preview.chatPrompt}
                        </pre>
                      </details>
                    )}
                    {preview.systemPrompt && (
                      <details style={styles.details}>
                        <summary style={styles.summary}>
                          Auftrag an das Modell (Regeln und Ton)
                        </summary>
                        <pre style={styles.pre}>
                          {preview.systemPrompt}
                        </pre>
                      </details>
                    )}
                  </>
                )}
              </Section>

              <Section title="Protokoll">
                {events.length === 0 ? (
                  <div style={styles.empty}>Noch keine Einträge.</div>
                ) : (
                  events.map(event => (
                    <div key={event.id} style={styles.eventRow}>
                      <span style={styles.eventTime}>
                        {formatStamp(event.createdAt)}
                      </span>
                      <span
                        style={{
                          ...styles.eventKind,
                          color:
                            event.kind === 'error'
                              ? 'var(--danger)'
                              : event.kind === 'sent'
                                ? 'var(--accent)'
                                : 'var(--text2)'
                        }}
                      >
                        {EVENT_LABELS[event.kind] || event.kind}
                      </span>
                      <span style={styles.eventText}>
                        {event.kind === 'sent' && event.detail
                          ? event.detail
                          : [event.reason, event.detail]
                              .filter(Boolean)
                              .join(' · ')}
                      </span>
                    </div>
                  ))
                )}
              </Section>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

export default function CompanionPanel({
  onClose,
  onOpenConversation,
  onConversationsChanged
}) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [models, setModels] = useState([])
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const applyData = useCallback(next => {
    setData(next)
    setDraft(pickEditable(next.settings, next.defaults))
  }, [])

  useEffect(() => {
    let alive = true

    api.get('/api/companion')
      .then(next => {
        if (alive) applyData(next)
      })
      .catch(err => {
        if (alive) {
          setError(err?.message || 'Luna konnte nicht geladen werden')
        }
      })

    api.get('/api/chat/models/list')
      .then(list => {
        if (alive && Array.isArray(list)) {
          setModels(list.map(item => item.name).filter(Boolean))
        }
      })
      .catch(() => {})

    return () => {
      alive = false
    }
  }, [applyData])

  const dirty =
    Boolean(data && draft) &&
    !sameDraft(draft, pickEditable(data.settings, data.defaults))

  async function run(task, successNotice = '') {
    setBusy(true)
    setError('')
    setNotice('')

    try {
      await task()

      if (successNotice) setNotice(successNotice)
    } catch (err) {
      setError(err?.message || 'Das hat nicht geklappt')
    } finally {
      setBusy(false)
    }
  }

  async function patch(body, successNotice) {
    await run(async () => {
      const next = await api.patch('/api/companion', body)

      applyData(next)

      if (next.settings.enabled && next.status.conversationId) {
        await onConversationsChanged?.()
      }
    }, successNotice)
  }

  return (
    <CompanionPanelView
      data={data}
      draft={draft}
      setDraft={setDraft}
      dirty={dirty}
      busy={busy}
      models={models}
      preview={preview}
      notice={notice}
      error={error}
      onClose={onClose}
      onToggleEnabled={enabled =>
        patch(
          { enabled },
          enabled
            ? 'Luna ist an. Der erste Plan entsteht im Zeitfenster.'
            : 'Luna ist aus.'
        )
      }
      onToggleMuted={muted =>
        patch({ muted }, muted ? 'Luna ist stumm.' : 'Luna ist wieder da.')
      }
      onSave={() =>
        patch(
          {
            ...draft,
            rules: normalizeRules(draft.rules, data?.defaults?.rules),
            intro: normalizeRules(draft.intro, data?.defaults?.intro)
          },
          'Gespeichert.'
        )
      }
      onReset={() =>
        setDraft(pickEditable(data.settings, data.defaults))
      }
      onPreview={() =>
        run(async () => {
          setPreview(await api.post('/api/companion/preview', {}))
          applyData(await api.get('/api/companion'))
        })
      }
      onSendNow={() =>
        run(async () => {
          const result = await api.post('/api/companion/send-now', {})

          applyData({
            settings: result.settings,
            status: result.status,
            defaults: result.defaults,
            events: result.events
          })

          await onConversationsChanged?.()
          setNotice(
            result.sent
              ? 'Nachricht gesendet.'
              : 'Luna hatte gerade nichts zu sagen.'
          )
        })
      }
      onReplan={() =>
        run(async () => {
          const next = await api.post('/api/companion/replan', {})

          applyData(next)
          setNotice(
            next.replanned
              ? `Neuer Plan: ${next.count} Meldung(en) für den Rest des Tages.`
              : 'Es wurde kein Plan erstellt. Luna ist aus, stumm oder gerade außerhalb des Zeitfensters.'
          )
        })
      }
      onOpenChat={() =>
        onOpenConversation?.(data?.status?.conversationId)
      }
    />
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 170,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    background: 'rgba(0,0,0,0.68)',
    backdropFilter: 'blur(4px)'
  },
  panel: {
    width: 'min(760px, 100%)',
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    border: '1px solid var(--border)',
    borderRadius: 15,
    background: 'var(--bg2)',
    boxShadow: '0 24px 70px rgba(0,0,0,0.55)'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)'
  },
  headerText: {
    minWidth: 0,
    flex: 1,
    display: 'grid',
    gap: 3
  },
  title: {
    color: 'var(--text1)',
    fontSize: 18,
    fontWeight: 700
  },
  subtitle: {
    color: 'var(--text3)',
    fontSize: 11
  },
  health: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700
  },
  close: {
    width: 40,
    height: 40,
    flexShrink: 0,
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 22
  },
  body: {
    minHeight: 0,
    overflowY: 'auto',
    padding:
      '16px 16px calc(22px + env(safe-area-inset-bottom))'
  },
  sectionTitle: {
    margin: '4px 2px 9px',
    color: 'var(--text3)',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em'
  },
  card: {
    display: 'grid',
    gap: 12,
    padding: 12,
    marginBottom: 22,
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--bg3)'
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  rowText: {
    minWidth: 0,
    display: 'grid',
    gap: 3
  },
  rowTitle: {
    color: 'var(--text1)',
    fontSize: 13
  },
  rowHint: {
    color: 'var(--text3)',
    fontSize: 11,
    lineHeight: 1.45
  },
  checkbox: {
    width: 22,
    height: 22,
    flexShrink: 0,
    accentColor: 'var(--accent)'
  },
  switchTrack: {
    position: 'relative',
    width: 48,
    height: 28,
    flexShrink: 0,
    padding: 3,
    border: '1px solid var(--border)',
    borderRadius: 999
  },
  switchKnob: {
    display: 'block',
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'var(--text1)',
    transition: 'transform 0.15s ease'
  },
  statusLines: {
    display: 'grid',
    gap: 8,
    color: 'var(--text2)',
    fontSize: 12,
    lineHeight: 1.45
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6
  },
  chip: {
    padding: '3px 9px',
    border: '1px solid var(--border)',
    borderRadius: 999,
    background: 'var(--bg2)',
    color: 'var(--text1)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11
  },
  buttonRow: {
    display: 'grid',
    gridTemplateColumns:
      'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 8
  },
  button: {
    minHeight: 42,
    padding: '0 12px',
    border: '1px solid var(--border)',
    borderRadius: 9,
    background: 'var(--bg2)',
    color: 'var(--text1)',
    fontSize: 12,
    fontWeight: 700
  },
  buttonPrimary: {
    borderColor: 'var(--accent-dim)',
    background: 'var(--accent-bg)',
    color: 'var(--accent)'
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns:
      'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 10
  },
  field: {
    display: 'grid',
    gap: 5,
    minWidth: 0
  },
  fieldLabel: {
    color: 'var(--text3)',
    fontSize: 10
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 40,
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 9,
    background: 'var(--bg2)',
    color: 'var(--text1)',
    fontSize: 13,
    fontFamily: 'inherit'
  },
  rulesInput: {
    resize: 'vertical',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1.5
  },
  saveBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 8,
    marginBottom: 22
  },
  bubble: {
    padding: 12,
    border: '1px solid var(--border)',
    borderLeft: '3px solid var(--accent)',
    borderRadius: 10,
    background: 'var(--bg2)',
    color: 'var(--text1)',
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
  },
  details: {
    border: '1px solid var(--border)',
    borderRadius: 9,
    background: 'var(--bg2)'
  },
  summary: {
    padding: '9px 11px',
    color: 'var(--text2)',
    fontSize: 12,
    cursor: 'pointer'
  },
  pre: {
    margin: 0,
    padding: '0 11px 11px',
    color: 'var(--text2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
  },
  eventRow: {
    display: 'grid',
    gridTemplateColumns: '78px 86px minmax(0, 1fr)',
    gap: 8,
    alignItems: 'baseline',
    fontSize: 11
  },
  eventTime: {
    color: 'var(--text3)',
    fontFamily: 'var(--font-mono)'
  },
  eventKind: {
    fontWeight: 700
  },
  eventText: {
    color: 'var(--text2)',
    overflowWrap: 'anywhere'
  },
  empty: {
    padding: 12,
    border: '1px dashed var(--border)',
    borderRadius: 10,
    color: 'var(--text3)',
    fontSize: 11,
    textAlign: 'center'
  },
  errorBox: {
    marginBottom: 14,
    padding: 11,
    border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--border))',
    borderRadius: 10,
    color: 'var(--danger)',
    fontSize: 12,
    overflowWrap: 'anywhere'
  },
  noticeBox: {
    marginBottom: 14,
    padding: 11,
    border: '1px solid color-mix(in srgb, var(--accent) 40%, var(--border))',
    borderRadius: 10,
    color: 'var(--text2)',
    fontSize: 12
  }
}
