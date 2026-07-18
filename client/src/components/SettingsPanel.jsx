import { useEffect, useState } from 'react'
import api from '../lib/api.js'
import { TEMPLATES } from '../lib/templates.jsx'

export default function SettingsPanel({
  conversation,
  onUpdate,
  onClose
}) {
  const [models, setModels] = useState([])
  const [form, setForm] = useState({
    model: conversation.model,
    system_prompt: conversation.system_prompt || '',
    temperature: conversation.temperature,
    top_k: conversation.top_k,
    top_p: conversation.top_p,
    reasoning_effort:
      conversation.reasoning_effort || ''
  })
  const [section, setSection] = useState('basic')
  const [defaultPrompt, setDefaultPrompt] =
    useState('')
  const [savingDefault, setSavingDefault] =
    useState(false)
  const [defaultSaved, setDefaultSaved] =
    useState(false)
  const [saving, setSaving] = useState(false)
  const [modelsError, setModelsError] =
    useState(false)

  // Provider aus Modellnamen ableiten.
  // Ollama-Einträge tragen nicht immer ein provider-Feld.
  function modelProvider(model) {
    if (model.provider) return model.provider

    return /[:-]cloud$/.test(model.name || '')
      ? 'ollama-cloud'
      : 'ollama'
  }

  const providerLabels = {
    'ollama-cloud': 'Ollama Cloud',
    ollama: 'Ollama (lokal)',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    zai: 'Z.ai'
  }

  const [provider, setProvider] = useState(null)

  const inferredProvider = modelProvider({
    name: form.model,
    provider: form.model.startsWith('claude')
      ? 'anthropic'
      : form.model.startsWith('openai/')
        ? 'openai'
        : form.model.startsWith('zai/')
          ? 'zai'
          : undefined
  })

  const currentProvider =
    provider ?? inferredProvider

  const availableProviders = [
    ...new Set(models.map(modelProvider))
  ]

  const filteredModels = models.filter(
    model =>
      modelProvider(model) === currentProvider
  )

  function set(key, value) {
    setForm(current => ({
      ...current,
      [key]: value
    }))
  }

  function switchProvider(nextProvider) {
    setProvider(nextProvider)

    const firstModel = models.find(
      model =>
        modelProvider(model) === nextProvider
    )

    if (
      firstModel &&
      inferredProvider !== nextProvider
    ) {
      set('model', firstModel.name)
    }
  }

  useEffect(() => {
    api
      .get('/api/chat/models/list')
      .then(data => setModels(data))
      .catch(() => setModelsError(true))

    api
      .get('/api/auth/default-prompt')
      .then(data =>
        setDefaultPrompt(data.prompt)
      )
  }, [])

  async function saveDefault() {
    setSavingDefault(true)

    try {
      await api.patch(
        '/api/auth/default-prompt',
        {
          prompt: defaultPrompt
        }
      )

      setDefaultSaved(true)
      setTimeout(
        () => setDefaultSaved(false),
        2000
      )
    } finally {
      setSavingDefault(false)
    }
  }

  async function save() {
    setSaving(true)

    try {
      const updated = await api.patch(
        `/api/conversations/${conversation.id}`,
        form
      )

      onUpdate(updated)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="echolink-fullscreen-overlay"
      style={styles.overlay}
      onClick={onClose}
    >
      <div
        className={
          'fade-in echolink-fullscreen-panel ' +
          'echolink-settings-panel'
        }
        style={styles.panel}
        onClick={event =>
          event.stopPropagation()
        }
      >
        <header style={styles.header}>
          <div style={styles.headerText}>
            <h2 style={styles.title}>
              Einstellungen
            </h2>

            <p style={styles.subtitle}>
              Unterhaltung und Modellverhalten
            </p>
          </div>

          <button
            type="button"
            style={styles.closeBtn}
            onClick={onClose}
            aria-label="Schließen"
          >
            ×
          </button>
        </header>

        <nav
          className="echolink-settings-tabs"
          aria-label="Einstellungsbereiche"
        >
          {[
            ['basic', 'Basis'],
            ['advanced', 'Erweitert']
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              aria-pressed={section === key}
              style={{
                ...styles.tabButton,
                ...(section === key
                  ? styles.tabButtonActive
                  : {})
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <div
          className="echolink-settings-body"
          style={styles.body}
        >
          {section === 'basic' ? (
            <>
              <section
                className="echolink-settings-section"
                style={styles.section}
              >
                <SectionHeading
                  title="Diese Unterhaltung"
                  description={
                    'Anbieter, Modell und Denkmodus ' +
                    'für den aktuellen Chat.'
                  }
                />

                <div className="echolink-settings-two-column">
                  <Field label="Anbieter">
                    <select
                      style={styles.select}
                      value={currentProvider}
                      onChange={event =>
                        switchProvider(
                          event.target.value
                        )
                      }
                    >
                      {availableProviders.length ===
                        0 && (
                        <option
                          value={currentProvider}
                        >
                          {providerLabels[
                            currentProvider
                          ] || currentProvider}
                        </option>
                      )}

                      {availableProviders.map(
                        item => (
                          <option
                            key={item}
                            value={item}
                          >
                            {providerLabels[item] ||
                              item}
                          </option>
                        )
                      )}
                    </select>
                  </Field>

                  <Field label="Modell">
                    {modelsError ? (
                      <p style={styles.error}>
                        Modelle konnten nicht geladen
                        werden.
                      </p>
                    ) : (
                      <select
                        style={styles.select}
                        value={form.model}
                        onChange={event =>
                          set(
                            'model',
                            event.target.value
                          )
                        }
                      >
                        {filteredModels.length ===
                          0 && (
                          <option value={form.model}>
                            {form.model}
                          </option>
                        )}

                        {filteredModels.map(model => (
                          <option
                            key={model.name}
                            value={model.name}
                          >
                            {model.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>

                <Field
                  label="Denkmodus"
                  hint={
                    'Steuert, wie intensiv unterstützte ' +
                    'Modelle intern schlussfolgern.'
                  }
                >
                  <select
                    value={form.reasoning_effort}
                    onChange={event =>
                      set(
                        'reasoning_effort',
                        event.target.value
                      )
                    }
                    style={styles.select}
                  >
                    <option value="">
                      Anbieter-Standard
                    </option>
                    <option value="off">Aus</option>
                    <option value="low">
                      Niedrig
                    </option>
                    <option value="medium">
                      Mittel
                    </option>
                    <option value="high">
                      Hoch
                    </option>
                  </select>
                </Field>
              </section>

              <section
                className="echolink-settings-section"
                style={styles.section}
              >
                <SectionHeading
                  title="System-Prompt"
                  description={
                    'Vorgaben nur für diese ' +
                    'Unterhaltung.'
                  }
                />

                <Field label="Prompt-Vorlage">
                  <TemplatePicker
                    value={form.system_prompt}
                    onSelect={template => {
                      set(
                        'system_prompt',
                        template.prompt
                      )

                      if (
                        template.temperature != null
                      ) {
                        set(
                          'temperature',
                          template.temperature
                        )
                      }
                    }}
                  />
                </Field>

                <Field label="Eigener System-Prompt">
                  <textarea
                    style={styles.textarea}
                    value={form.system_prompt}
                    onChange={event =>
                      set(
                        'system_prompt',
                        event.target.value
                      )
                    }
                    placeholder={
                      'Optional: eigene Anweisungen ' +
                      'für diese Unterhaltung …'
                    }
                    rows={6}
                  />
                </Field>
              </section>
            </>
          ) : (
            <>
              <section
                className="echolink-settings-section"
                style={styles.section}
              >
                <SectionHeading
                  title="Antwortparameter"
                  description={
                    'Feinabstimmung der ' +
                    'Modellausgabe.'
                  }
                />

                <div className="echolink-settings-parameter-grid">
                  <RangeField
                    label="Temperatur"
                    value={form.temperature}
                    displayValue={
                      form.temperature.toFixed(2)
                    }
                    min="0"
                    max="2"
                    step="0.05"
                    onChange={value =>
                      set(
                        'temperature',
                        parseFloat(value)
                      )
                    }
                  />

                  <RangeField
                    label="Top-K"
                    value={form.top_k}
                    displayValue={form.top_k}
                    min="1"
                    max="100"
                    step="1"
                    onChange={value =>
                      set(
                        'top_k',
                        parseInt(value, 10)
                      )
                    }
                  />

                  <RangeField
                    label="Top-P"
                    value={form.top_p}
                    displayValue={
                      form.top_p.toFixed(2)
                    }
                    min="0"
                    max="1"
                    step="0.05"
                    onChange={value =>
                      set(
                        'top_p',
                        parseFloat(value)
                      )
                    }
                  />
                </div>

                <p style={styles.note}>
                  Diese Werte bleiben unverändert,
                  solange du die Schieberegler nicht
                  bewegst.
                </p>
              </section>

              <section
                className="echolink-settings-section"
                style={styles.section}
              >
                <SectionHeading
                  title="Standard-Prompt"
                  description={
                    'Wird automatisch für neue ' +
                    'Unterhaltungen verwendet.'
                  }
                />

                <Field label="Prompt-Vorlage">
                  <TemplatePicker
                    value={defaultPrompt}
                    onSelect={template =>
                      setDefaultPrompt(
                        template.prompt
                      )
                    }
                  />
                </Field>

                <Field label="Standard-Prompt">
                  <textarea
                    style={styles.textarea}
                    value={defaultPrompt}
                    onChange={event =>
                      setDefaultPrompt(
                        event.target.value
                      )
                    }
                    placeholder={
                      'Du bist ein hilfreicher ' +
                      'Assistent …'
                    }
                    rows={7}
                  />
                </Field>

                <button
                  type="button"
                  className="echolink-settings-default-save"
                  style={{
                    ...styles.saveDefaultBtn,
                    opacity: savingDefault
                      ? 0.6
                      : 1
                  }}
                  onClick={saveDefault}
                  disabled={savingDefault}
                >
                  {defaultSaved
                    ? '✓ Gespeichert'
                    : savingDefault
                      ? 'Speichert …'
                      : 'Als Standard speichern'}
                </button>
              </section>
            </>
          )}
        </div>

        <footer style={styles.footer}>
          <button
            type="button"
            style={styles.cancelBtn}
            onClick={onClose}
          >
            Abbrechen
          </button>

          <button
            type="button"
            style={{
              ...styles.saveBtn,
              opacity: saving ? 0.6 : 1
            }}
            onClick={save}
            disabled={saving}
          >
            {saving
              ? 'Speichert …'
              : 'Unterhaltung speichern'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function SectionHeading({
  title,
  description
}) {
  return (
    <div style={styles.sectionHeading}>
      <h3 style={styles.sectionTitle}>
        {title}
      </h3>

      <p style={styles.sectionDescription}>
        {description}
      </p>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}) {
  return (
    <div
      className="echolink-settings-field"
      style={styles.field}
    >
      {label ? (
        <label style={styles.label}>
          {label}
        </label>
      ) : null}

      {hint ? (
        <p style={styles.fieldHint}>
          {hint}
        </p>
      ) : null}

      {children}
    </div>
  )
}

function RangeField({
  label,
  value,
  displayValue,
  min,
  max,
  step,
  onChange
}) {
  return (
    <div
      className="echolink-settings-range-card"
      style={styles.rangeCard}
    >
      <div style={styles.rangeHeader}>
        <span style={styles.rangeLabel}>
          {label}
        </span>

        <strong style={styles.rangeValue}>
          {displayValue}
        </strong>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event =>
          onChange(event.target.value)
        }
        style={styles.range}
      />
    </div>
  )
}

function TemplatePicker({
  value,
  onSelect
}) {
  return (
    <div style={styles.templates}>
      {TEMPLATES.map(template => {
        const active =
          value === template.prompt

        return (
          <button
            key={template.id}
            type="button"
            style={{
              ...styles.templateBtn,
              ...(active
                ? styles.templateActive
                : {})
            }}
            onClick={() =>
              onSelect(template)
            }
            title={template.description}
          >
            <span
              style={{
                color: active
                  ? 'var(--accent)'
                  : 'var(--text2)'
              }}
            >
              {template.icon}
            </span>

            <span style={styles.templateLabel}>
              {template.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

const styles = {
  overlay: {
    paddingTop:
      'env(safe-area-inset-top)',
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    zIndex: 200,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'flex-end'
  },
  panel: {
    width: 500,
    maxWidth: '100vw',
    height: '100%',
    minHeight: 0,
    background: 'var(--bg2)',
    borderLeft:
      '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '16px 20px',
    borderBottom:
      '1px solid var(--border)'
  },
  headerText: {
    flex: 1,
    minWidth: 0
  },
  title: {
    margin: 0,
    fontFamily: 'var(--font-mono)',
    fontSize: 16,
    fontWeight: 700
  },
  subtitle: {
    margin: '3px 0 0',
    color: 'var(--text3)',
    fontSize: 11
  },
  closeBtn: {
    width: 36,
    height: 36,
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    border:
      '1px solid var(--border)',
    borderRadius: 9,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 22,
    lineHeight: 1,
    cursor: 'pointer'
  },
  tabButton: {
    minHeight: 38,
    padding: '8px 12px',
    border:
      '1px solid transparent',
    borderRadius: 9,
    background: 'transparent',
    color: 'var(--text2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    cursor: 'pointer'
  },
  tabButtonActive: {
    borderColor: 'var(--border)',
    background: 'var(--bg3)',
    color: 'var(--accent)'
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: 16
  },
  section: {
    marginBottom: 12,
    padding: 14,
    border:
      '1px solid var(--border)',
    borderRadius: 12,
    background: 'var(--bg1)'
  },
  sectionHeading: {
    marginBottom: 15
  },
  sectionTitle: {
    margin: 0,
    color: 'var(--text1)',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    fontWeight: 700
  },
  sectionDescription: {
    margin: '4px 0 0',
    color: 'var(--text3)',
    fontSize: 11,
    lineHeight: 1.45
  },
  field: {
    marginBottom: 16
  },
  label: {
    display: 'block',
    marginBottom: 7,
    color: 'var(--text2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.05em',
    textTransform: 'uppercase'
  },
  fieldHint: {
    margin: '-2px 0 8px',
    color: 'var(--text3)',
    fontSize: 11,
    lineHeight: 1.4
  },
  error: {
    margin: 0,
    color: 'var(--danger)',
    fontSize: 12
  },
  templates: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6
  },
  templateBtn: {
    minWidth: 64,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '8px 10px',
    border:
      '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    cursor: 'pointer',
    transition:
      'all var(--transition)'
  },
  templateActive: {
    borderColor:
      'var(--accent-dim)',
    background: 'var(--accent-bg)',
    color: 'var(--text1)'
  },
  templateLabel: {
    fontSize: 11
  },
  select: {
    width: '100%',
    padding: '10px 12px',
    border:
      '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg3)',
    color: 'var(--text1)',
    outline: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    cursor: 'pointer'
  },
  textarea: {
    width: '100%',
    minHeight: 100,
    boxSizing: 'border-box',
    padding: 12,
    resize: 'vertical',
    border:
      '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg3)',
    color: 'var(--text1)',
    outline: 'none',
    fontFamily: 'var(--font-sans)',
    fontSize: 14,
    lineHeight: 1.5
  },
  rangeCard: {
    padding: 11,
    border:
      '1px solid var(--border)',
    borderRadius: 10,
    background: 'var(--bg3)'
  },
  rangeHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 9
  },
  rangeLabel: {
    color: 'var(--text2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11
  },
  rangeValue: {
    color: 'var(--accent)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11
  },
  range: {
    width: '100%',
    accentColor: 'var(--green)',
    cursor: 'pointer'
  },
  note: {
    margin: '12px 0 0',
    color: 'var(--text3)',
    fontSize: 10,
    lineHeight: 1.45
  },
  saveDefaultBtn: {
    width: '100%',
    padding: 10,
    border:
      '1px solid var(--green-dim)',
    borderRadius: 8,
    background: 'var(--green-bg)',
    color: 'var(--green)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    cursor: 'pointer'
  },
  footer: {
    display: 'flex',
    flexShrink: 0,
    gap: 10,
    padding:
      '12px 16px calc(12px + env(safe-area-inset-bottom))',
    borderTop:
      '1px solid var(--border)',
    background: 'var(--bg2)'
  },
  cancelBtn: {
    flex: 1,
    padding: 11,
    border:
      '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 14,
    cursor: 'pointer'
  },
  saveBtn: {
    flex: 1,
    padding: 11,
    border: 'none',
    borderRadius: 8,
    background: 'var(--green)',
    color: '#0d0d0d',
    fontFamily: 'var(--font-sans)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer'
  }
}
