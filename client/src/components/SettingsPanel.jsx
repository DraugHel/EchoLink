import { useState, useEffect } from 'react'
import api from '../lib/api.js'

export default function SettingsPanel({ conversation, onUpdate, onClose }) {
  const [models, setModels] = useState([])
  const [form, setForm] = useState({
    model: conversation.model,
    system_prompt: conversation.system_prompt || '',
    temperature: conversation.temperature,
    top_k: conversation.top_k,
    top_p: conversation.top_p,
  })
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [savingDefault, setSavingDefault] = useState(false)
  const [defaultSaved, setDefaultSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [modelsError, setModelsError] = useState(false)

  useEffect(() => {
    api.get('/api/chat/models/list').then(m => setModels(m)).catch(() => setModelsError(true))
    api.get('/api/auth/default-prompt').then(d => setDefaultPrompt(d.prompt))
  }, [])

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }))
  }

  async function saveDefault() {
    setSavingDefault(true)
    try {
      await api.patch('/api/auth/default-prompt', { prompt: defaultPrompt })
      setDefaultSaved(true)
      setTimeout(() => setDefaultSaved(false), 2000)
    } finally {
      setSavingDefault(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      const updated = await api.patch(`/api/conversations/${conversation.id}`, form)
      onUpdate(updated)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={e => e.stopPropagation()} className="fade-in">
        <div style={styles.header}>
          <h2 style={styles.title}>Settings</h2>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.body}>
          {/* Conversation settings */}
          <p style={styles.sectionLabel}>This Conversation</p>

          <Field label="Model">
            {modelsError
              ? <p style={styles.err}>Could not fetch models from Ollama.</p>
              : (
                <select style={styles.select} value={form.model} onChange={e => set('model', e.target.value)}>
                  {models.length === 0 && <option value={form.model}>{form.model}</option>}
                  {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
              )
            }
          </Field>

          <Field label={`Temperature: ${form.temperature.toFixed(2)}`}>
            <input type="range" min="0" max="2" step="0.05" value={form.temperature}
              onChange={e => set('temperature', parseFloat(e.target.value))} style={styles.range} />
          </Field>

          <Field label={`Top-K: ${form.top_k}`}>
            <input type="range" min="1" max="100" step="1" value={form.top_k}
              onChange={e => set('top_k', parseInt(e.target.value))} style={styles.range} />
          </Field>

          <Field label={`Top-P: ${form.top_p.toFixed(2)}`}>
            <input type="range" min="0" max="1" step="0.05" value={form.top_p}
              onChange={e => set('top_p', parseFloat(e.target.value))} style={styles.range} />
          </Field>

          <Field label="System Prompt (this conversation)">
            <textarea
              style={styles.textarea}
              value={form.system_prompt}
              onChange={e => set('system_prompt', e.target.value)}
              placeholder="Override default prompt for this conversation…"
              rows={4}
            />
          </Field>

          {/* Divider */}
          <div style={styles.divider} />

          {/* Default prompt */}
          <p style={styles.sectionLabel}>Your Default Prompt</p>
          <p style={styles.sectionSub}>Applied to all new conversations automatically.</p>

          <Field label="">
            <textarea
              style={styles.textarea}
              value={defaultPrompt}
              onChange={e => setDefaultPrompt(e.target.value)}
              placeholder="You are a helpful assistant…"
              rows={5}
            />
          </Field>
          <button
            style={{ ...styles.saveDefaultBtn, opacity: savingDefault ? 0.6 : 1 }}
            onClick={saveDefault}
            disabled={savingDefault}
          >
            {defaultSaved ? '✓ Saved' : savingDefault ? 'Saving…' : 'Save as Default'}
          </button>
        </div>

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={{ ...styles.saveBtn, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Conversation'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      {label ? (
        <label style={{ display:'block', fontSize:11, color:'var(--text2)', marginBottom:7, textTransform:'uppercase', letterSpacing:'0.05em', fontFamily:'var(--font-mono)' }}>
          {label}
        </label>
      ) : null}
      {children}
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
    zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end'
  },
  panel: {
    width: 380, maxWidth: '100vw', height: '100%',
    background: 'var(--bg2)', borderLeft: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column'
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 24px', borderBottom: '1px solid var(--border)'
  },
  title: { fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700 },
  closeBtn: { color: 'var(--text2)', fontSize: 18, lineHeight: 1 },
  body: { flex: 1, overflowY: 'auto', padding: '20px 24px' },
  sectionLabel: {
    fontSize: 12, fontWeight: 600, color: 'var(--text)',
    fontFamily: 'var(--font-mono)', marginBottom: 4
  },
  sectionSub: { fontSize: 12, color: 'var(--text2)', marginBottom: 16 },
  divider: { borderTop: '1px solid var(--border)', margin: '24px 0' },
  footer: { display: 'flex', gap: 10, padding: '16px 24px', borderTop: '1px solid var(--border)' },
  err: { color: 'var(--danger)', fontSize: 13 },
  select: {
    width: '100%', padding: '10px 12px', fontSize: 16,
    background: 'var(--bg3)', border: '1px solid var(--border)',
    borderRadius: 8, color: 'var(--text)', outline: 'none', cursor: 'pointer'
  },
  range: { width: '100%', accentColor: 'var(--green)', cursor: 'pointer' },
  textarea: {
    width: '100%', padding: '12px', fontSize: 16,
    resize: 'vertical', minHeight: 90, borderRadius: 8, lineHeight: 1.5
  },
  saveDefaultBtn: {
    width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
    background: 'var(--green-bg)', color: 'var(--green)',
    border: '1px solid var(--green-dim)', cursor: 'pointer',
    fontFamily: 'var(--font-sans)', marginTop: -8, marginBottom: 4
  },
  cancelBtn: {
    flex: 1, padding: '11px', borderRadius: 8, fontSize: 14,
    color: 'var(--text2)', border: '1px solid var(--border)', background: 'var(--bg3)'
  },
  saveBtn: {
    flex: 1, padding: '11px', borderRadius: 8, fontSize: 14,
    fontWeight: 600, background: 'var(--green)', color: '#0d0d0d',
    border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)'
  }
}
