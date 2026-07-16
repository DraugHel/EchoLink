import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api.js'

const PRESETS = {
  '1': { startTime: '04:00', endTime: '12:00', title: 'Frühschicht' },
  '2': { startTime: '12:00', endTime: '20:00', title: 'Spätschicht' },
  '3': { startTime: '20:00', endTime: '04:00', title: 'Nachtschicht' }
}
const CODES = ['', '1', '2', '3', 'F', 'X', 'P', 'K', 'S', 'N']

async function responseError(response) {
  const data = await response.json().catch(() => ({}))
  return new Error(data?.error || `HTTP ${response.status}`)
}

function confidence(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${Math.round(number * 100)} %` : '–'
}

function statusText(status) {
  if (status === 'created') return 'Importiert'
  if (status === 'duplicate') return 'Schon vorhanden'
  if (status === 'error') return 'Fehler'
  return ''
}

export default function ShiftImporter({ onClose }) {
  const [file, setFile] = useState(null)
  const [columnNumber, setColumnNumber] = useState(1)
  const [draft, setDraft] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState(null)

  useEffect(() => {
    let alive = true
    api.get('/api/shift-imports/latest')
      .then(data => {
        if (!alive || !data?.import) return
        setDraft(data.import)
        setItems(data.items || [])
        setColumnNumber(data.import.columnNumber || 1)
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const enabledCount = useMemo(() => items.filter(item => item.enabled).length, [items])
  const uncertainCount = useMemo(() => items.filter(item => Number(item.confidence) < 0.85).length, [items])

  function updateItem(id, patch) {
    setItems(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item))
  }

  function changeCode(item, code) {
    const preset = PRESETS[code]
    updateItem(item.id, preset
      ? { code, ...preset, enabled: Number(item.confidence) >= 0.85 }
      : { code, enabled: false })
  }

  async function analyze(event) {
    event.preventDefault()
    if (!file) return setError('Bitte zuerst ein Foto auswählen.')
    setAnalyzing(true)
    setError('')
    setSummary(null)
    try {
      const body = new FormData()
      body.append('image', file)
      body.append('columnNumber', String(columnNumber))
      const response = await fetch('/api/shift-imports/analyze', { method: 'POST', body })
      if (!response.ok) throw await responseError(response)
      const data = await response.json()
      setDraft(data.import)
      setItems(data.items || [])
    } catch (failure) {
      setError(failure?.message || 'Analyse fehlgeschlagen')
    } finally {
      setAnalyzing(false)
    }
  }

  async function saveItems() {
    if (!draft?.id) return null
    setSaving(true)
    setError('')
    try {
      const data = await api.put(`/api/shift-imports/${draft.id}/items`, { items })
      setDraft(data.import)
      setItems(data.items || [])
      return data
    } catch (failure) {
      setError(failure?.message || 'Vorschau konnte nicht gespeichert werden')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function importCalendar() {
    if (!draft?.id || enabledCount === 0) return setError('Keine importierbaren Schichten ausgewählt.')
    setImporting(true)
    setError('')
    setSummary(null)
    try {
      const saved = await saveItems()
      if (!saved) return
      const data = await api.post(`/api/shift-imports/${draft.id}/import`, { timeZone: 'Europe/Vienna' })
      setDraft(data.import)
      setItems(data.items || [])
      setSummary(data.summary || null)
    } catch (failure) {
      setError(failure?.message || 'Kalenderimport fehlgeschlagen')
    } finally {
      setImporting(false)
    }
  }

  function startNew() {
    setDraft(null)
    setItems([])
    setFile(null)
    setSummary(null)
    setError('')
  }

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <section style={styles.panel}>
        <header style={styles.header}>
          <div>
            <h2 style={styles.title}>Schichtplan importieren</h2>
            <p style={styles.subtitle}>Foto prüfen, korrigieren und gesammelt in Google Calendar eintragen.</p>
          </div>
          <button type="button" onClick={onClose} style={styles.close} aria-label="Schließen">×</button>
        </header>

        <div style={styles.body}>
          {loading ? (
            <div style={styles.loading}>Letzten Entwurf laden …</div>
          ) : !draft ? (
            <form onSubmit={analyze} style={styles.uploadCard}>
              <label style={styles.label}>
                Schichtplanfoto
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setFile(event.target.files?.[0] || null)} />
              </label>
              <label style={styles.label}>
                Meine Mitarbeiterspalte
                <input type="number" min="1" max="100" value={columnNumber} onChange={event => setColumnNumber(Math.max(1, Number(event.target.value) || 1))} style={styles.smallInput} />
              </label>
              <div style={styles.hint}>Spalte 1 ist die erste Mitarbeiterspalte direkt rechts von Datum und Tag. Die Analyse schreibt noch nichts in den Kalender.</div>
              <button type="submit" disabled={analyzing || !file} style={{ ...styles.primary, opacity: analyzing || !file ? 0.55 : 1 }}>
                {analyzing ? 'Bild wird analysiert …' : 'Vorschau erstellen'}
              </button>
            </form>
          ) : (
            <>
              <div style={styles.summaryCard}>
                <div>
                  <strong>{draft.originalName}</strong>
                  <div style={styles.muted}>Spalte {draft.columnNumber} · {draft.planStart || '–'} bis {draft.planEnd || '–'} · {draft.model || '–'}</div>
                </div>
                <button type="button" onClick={startNew} style={styles.secondary}>Neues Foto</button>
              </div>

              {draft.warnings?.length > 0 && (
                <div style={styles.warning}>{draft.warnings.map((text, index) => <div key={index}>{text}</div>)}</div>
              )}

              <div style={styles.stats}>
                <span>{items.length} Datumszeilen</span>
                <span>{enabledCount} ausgewählt</span>
                <span>{uncertainCount} unsicher</span>
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {['Import', 'Datum', 'Code', 'Beginn', 'Ende', 'Titel', 'Sicherheit', 'Hinweis', 'Status'].map(label => <th key={label} style={styles.th}>{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(item => {
                      const supported = Boolean(PRESETS[item.code])
                      const uncertain = Number(item.confidence) < 0.85
                      const locked = item.importStatus === 'created' || item.importStatus === 'duplicate'
                      return (
                        <tr key={item.id} style={uncertain ? styles.uncertain : undefined}>
                          <td style={styles.td}><input type="checkbox" checked={item.enabled} disabled={!supported || locked} onChange={event => updateItem(item.id, { enabled: event.target.checked })} /></td>
                          <td style={styles.td}><input type="date" value={item.workDate} onChange={event => updateItem(item.id, { workDate: event.target.value })} style={styles.input} /></td>
                          <td style={styles.td}>
                            <select value={item.code} onChange={event => changeCode(item, event.target.value)} style={styles.input}>
                              {!CODES.includes(item.code) && <option value={item.code}>{item.code}</option>}
                              {CODES.map(code => <option key={code || 'empty'} value={code}>{code || '–'}</option>)}
                            </select>
                          </td>
                          <td style={styles.td}><input type="time" value={item.startTime || ''} onChange={event => updateItem(item.id, { startTime: event.target.value })} style={styles.input} /></td>
                          <td style={styles.td}><input type="time" value={item.endTime || ''} onChange={event => updateItem(item.id, { endTime: event.target.value })} style={styles.input} /></td>
                          <td style={styles.td}><input type="text" value={item.title || ''} onChange={event => updateItem(item.id, { title: event.target.value })} style={{ ...styles.input, minWidth: 130 }} /></td>
                          <td style={{ ...styles.td, color: uncertain ? 'var(--danger)' : 'var(--text2)' }}>{confidence(item.confidence)}</td>
                          <td style={styles.td}><textarea rows="2" value={item.note || ''} onChange={event => updateItem(item.id, { note: event.target.value })} style={{ ...styles.input, minWidth: 180, resize: 'vertical' }} /></td>
                          <td style={styles.td}>
                            <span style={{ color: item.importStatus === 'error' ? 'var(--danger)' : item.importStatus === 'created' ? 'var(--green)' : 'var(--text3)' }}>{statusText(item.importStatus)}</span>
                            {item.error && <div style={styles.rowError}>{item.error}</div>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {summary && <div style={styles.success}>{summary.created} erstellt · {summary.duplicates} bereits vorhanden · {summary.errors} Fehler</div>}

              <div style={styles.footer}>
                <button type="button" onClick={saveItems} disabled={saving || importing} style={styles.secondary}>{saving ? 'Speichert …' : 'Vorschau speichern'}</button>
                <button type="button" onClick={importCalendar} disabled={saving || importing || enabledCount === 0} style={{ ...styles.primary, opacity: saving || importing || enabledCount === 0 ? 0.55 : 1 }}>
                  {importing ? 'Kalenderimport läuft …' : `${enabledCount} Schichten importieren`}
                </button>
              </div>
              <div style={styles.hint}>Nur aktivierte Codes 1, 2 und 3 werden importiert. Ein Ende vor dem Beginn gilt als Folgetag. Bereits durch diesen Importer erstellte gleiche Schichten werden übersprungen.</div>
            </>
          )}

          {error && <div style={styles.error}>{error}</div>}
        </div>
      </section>
    </>
  )
}

const styles = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 110, background: 'rgba(0,0,0,0.7)' },
  panel: { position: 'fixed', zIndex: 111, inset: 'max(10px, env(safe-area-inset-top)) 10px max(10px, env(safe-area-inset-bottom))', maxWidth: 1180, margin: '0 auto', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg2)', boxShadow: '0 24px 70px rgba(0,0,0,0.55)' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, padding: '16px 18px', borderBottom: '1px solid var(--border)' },
  title: { margin: 0, fontSize: 18, color: 'var(--text)' },
  subtitle: { margin: '5px 0 0', color: 'var(--text3)', fontSize: 12 },
  close: { width: 32, height: 32, flexShrink: 0, borderRadius: 8, color: 'var(--text2)', background: 'var(--bg3)', fontSize: 22, lineHeight: 1 },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 },
  loading: { padding: 40, textAlign: 'center', color: 'var(--text3)' },
  uploadCard: { maxWidth: 520, margin: '30px auto', padding: 18, display: 'grid', gap: 15, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg3)' },
  label: { display: 'grid', gap: 7, color: 'var(--text2)', fontSize: 12, fontWeight: 600 },
  smallInput: { width: 100, padding: '9px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)', color: 'var(--text)' },
  hint: { marginTop: 10, color: 'var(--text3)', fontSize: 10, lineHeight: 1.5 },
  summaryCard: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 15, padding: 12, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg3)' },
  muted: { marginTop: 4, color: 'var(--text3)', fontSize: 11 },
  stats: { display: 'flex', flexWrap: 'wrap', gap: 12, margin: '12px 0', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--font-mono)' },
  tableWrap: { maxWidth: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch', border: '1px solid var(--border)', borderRadius: 10 },
  table: { width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', background: 'var(--bg2)' },
  th: { position: 'sticky', top: 0, zIndex: 1, padding: '9px 8px', borderBottom: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text3)', fontSize: 10, textAlign: 'left', whiteSpace: 'nowrap' },
  td: { padding: 6, borderBottom: '1px solid var(--border)', color: 'var(--text2)', fontSize: 11, verticalAlign: 'top' },
  uncertain: { background: 'rgba(255,90,90,0.045)' },
  input: { minWidth: 90, maxWidth: 240, padding: '7px 8px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg3)', color: 'var(--text)', fontSize: 12 },
  rowError: { marginTop: 4, maxWidth: 220, color: 'var(--danger)', fontSize: 10, overflowWrap: 'anywhere' },
  footer: { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  primary: { padding: '10px 14px', borderRadius: 8, background: 'var(--accent)', color: '#0d0d0d', fontWeight: 700, fontSize: 12 },
  secondary: { padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg3)', color: 'var(--text2)', fontSize: 12 },
  warning: { marginTop: 10, padding: 10, border: '1px solid rgba(230,180,70,0.35)', borderRadius: 9, background: 'rgba(230,180,70,0.08)', color: 'var(--text2)', fontSize: 11, lineHeight: 1.5 },
  success: { marginTop: 12, padding: 10, border: '1px solid var(--green-dim)', borderRadius: 9, background: 'var(--green-bg)', color: 'var(--green)', fontSize: 12 },
  error: { marginTop: 12, padding: 10, border: '1px solid rgba(255,80,80,0.3)', borderRadius: 9, background: 'rgba(255,80,80,0.08)', color: 'var(--danger)', fontSize: 12 }
}
