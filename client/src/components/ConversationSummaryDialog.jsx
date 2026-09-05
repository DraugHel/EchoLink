import { useEffect, useMemo, useRef, useState } from 'react'
import api from '../lib/api.js'
import './ConversationSummaryDialog.css'

function requestId(prefix) {
  const id = globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}:${id}`
}

function formatCost(cost) {
  if (!cost) return ''
  if (cost.calls === 0) return ''
  const known = Number(cost.knownUsd || 0)
  if (cost.complete) {
    return `Kosten: $${known.toFixed(5)} · ${cost.calls} Modellaufruf${cost.calls === 1 ? '' : 'e'}`
  }
  return `Bekannte Kosten: $${known.toFixed(5)} · ${cost.unpricedCalls || 0} Aufruf/Aufrufe ohne Preis- oder Usage-Daten`
}

export default function ConversationSummaryDialog({
  conversation,
  availableModels = [],
  chatBusy = false,
  onClose,
  onContinued
}) {
  const [selectedModel, setSelectedModel] = useState(conversation.model || '')
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [revision, setRevision] = useState(null)
  const [stale, setStale] = useState(false)
  const [activeRun, setActiveRun] = useState(false)
  const [messageCount, setMessageCount] = useState(0)
  const [generationPlan, setGenerationPlan] = useState(null)
  const [planError, setPlanError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [cost, setCost] = useState(null)
  const generationRequestRef = useRef(null)
  const mountedRef = useRef(true)
  const loadedDraftRef = useRef(false)

  const models = useMemo(() => (
    Array.from(new Set([
      conversation.model,
      ...availableModels
    ].filter(Boolean)))
  ), [conversation.model, availableModels])

  const dirty = revision != null && content !== savedContent
  const busy = generating || saving || continuing
  const sourceBlocked = chatBusy || activeRun || messageCount === 0

  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadState() {
      setLoading(true)
      setError('')
      try {
        const state = await api.get(
          `/api/conversations/${conversation.id}/summary?model=${encodeURIComponent(selectedModel)}`
        )
        if (cancelled || !mountedRef.current) return

        setStale(Boolean(state?.stale))
        setActiveRun(Boolean(state?.activeRun))
        setMessageCount(Number(state?.source?.messageCount) || 0)
        setGenerationPlan(state?.generationPlan || null)
        setPlanError(state?.planError || null)

        if (!loadedDraftRef.current) {
          const summary = state?.summary
          if (summary) {
            setContent(summary.content || '')
            setSavedContent(summary.content || '')
            setRevision(summary.revision)
          }
          loadedDraftRef.current = true
        }
      } catch (loadError) {
        if (!cancelled && mountedRef.current) {
          setError(loadError?.message || 'Summary-Status konnte nicht geladen werden.')
        }
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false)
      }
    }

    loadState()
    return () => { cancelled = true }
  }, [conversation.id, selectedModel])

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && !busy) onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  async function refreshState({ preserveDraft = true } = {}) {
    const state = await api.get(
      `/api/conversations/${conversation.id}/summary?model=${encodeURIComponent(selectedModel)}`
    )
    if (!mountedRef.current) return state
    setStale(Boolean(state?.stale))
    setActiveRun(Boolean(state?.activeRun))
    setMessageCount(Number(state?.source?.messageCount) || 0)
    setGenerationPlan(state?.generationPlan || null)
    setPlanError(state?.planError || null)
    if (!preserveDraft && state?.summary) {
      setContent(state.summary.content || '')
      setSavedContent(state.summary.content || '')
      setRevision(state.summary.revision)
    }
    return state
  }

  async function generateSummary() {
    if (revision != null) {
      const confirmed = window.confirm(
        dirty
          ? 'Du hast ungespeicherte manuelle Änderungen. Eine erfolgreich neu erstellte Zusammenfassung ersetzt den bisherigen Entwurf und diese Änderungen. Fortfahren?'
          : 'Eine erfolgreich neu erstellte Zusammenfassung ersetzt den gespeicherten Entwurf einschließlich eventueller manueller Änderungen. Fortfahren?'
      )
      if (!confirmed) return
    }

    const id = requestId('summary')
    generationRequestRef.current = id
    setGenerating(true)
    setError('')
    setNotice('')
    setCost(null)

    try {
      const result = await api.post(
        `/api/conversations/${conversation.id}/summary/generate`,
        { model: selectedModel, requestId: id }
      )
      if (!mountedRef.current || generationRequestRef.current !== id) return
      const summary = result?.summary
      if (!summary) throw new Error('Server hat keinen Summary-Entwurf geliefert.')
      setContent(summary.content || '')
      setSavedContent(summary.content || '')
      setRevision(summary.revision)
      setStale(false)
      setCost(result?.cost || null)
      setNotice('Zusammenfassung erstellt und als Entwurf gespeichert.')
      await refreshState({ preserveDraft: true })
    } catch (generationError) {
      if (!mountedRef.current || generationRequestRef.current !== id) return
      setError(generationError?.message || 'Zusammenfassung fehlgeschlagen.')
      try { await refreshState({ preserveDraft: true }) } catch {}
    } finally {
      if (mountedRef.current && generationRequestRef.current === id) {
        setGenerating(false)
        setCancelling(false)
        generationRequestRef.current = null
      }
    }
  }

  async function cancelGeneration() {
    const id = generationRequestRef.current
    if (!id || cancelling) return
    setCancelling(true)
    setError('')
    try {
      await api.post(
        `/api/conversations/${conversation.id}/summary/cancel`,
        { requestId: id }
      )
      if (mountedRef.current) setNotice('Abbruch angefordert. Ein vorhandener Entwurf bleibt erhalten.')
    } catch (cancelError) {
      if (mountedRef.current) {
        setError(cancelError?.message || 'Abbruch fehlgeschlagen.')
        setCancelling(false)
      }
    }
  }

  async function saveSummary() {
    if (revision == null || saving) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await api.patch(
        `/api/conversations/${conversation.id}/summary`,
        { content, expectedRevision: revision }
      )
      if (!mountedRef.current) return
      setRevision(result.summary.revision)
      setSavedContent(result.summary.content || '')
      setContent(result.summary.content || '')
      setStale(false)
      setNotice('Entwurf gespeichert.')
    } catch (saveError) {
      if (mountedRef.current) setError(saveError?.message || 'Speichern fehlgeschlagen.')
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  async function copySummary() {
    setError('')
    try {
      await navigator.clipboard.writeText(content)
      if (mountedRef.current) setNotice('Zusammenfassung kopiert.')
    } catch {
      if (mountedRef.current) setError('Kopieren ist in diesem Browser nicht verfügbar.')
    }
  }

  async function continueInNewChat() {
    if (revision == null || continuing) return
    const id = requestId('summary-continue')
    setContinuing(true)
    setError('')
    setNotice('')
    try {
      const result = await api.post(
        `/api/conversations/${conversation.id}/summary/continue`,
        {
          content,
          expectedRevision: revision,
          requestId: id
        }
      )
      if (!mountedRef.current) return
      await onContinued?.(result.conversation)
    } catch (continueError) {
      if (mountedRef.current) setError(continueError?.message || 'Fortsetzung konnte nicht erstellt werden.')
    } finally {
      if (mountedRef.current) setContinuing(false)
    }
  }

  const generateDisabled =
    busy || loading || sourceBlocked || Boolean(planError) || !selectedModel
  const saveDisabled =
    busy || revision == null || stale || !dirty || !content.trim()
  const continueDisabled =
    busy || revision == null || stale || sourceBlocked || !content.trim()

  return (
    <div className="summary-dialog-overlay" role="presentation">
      <section
        className="summary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="summary-dialog-title"
      >
        <header className="summary-dialog-header">
          <div>
            <h2 id="summary-dialog-title">Chat zusammenfassen</h2>
            <div className="summary-dialog-source">{conversation.title}</div>
          </div>
          <button
            type="button"
            className="summary-icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Dialog schließen"
            title={busy ? 'Während des Speicherns oder der Übernahme nicht schließen' : 'Schließen'}
          >
            ×
          </button>
        </header>

        <div className="summary-dialog-body">
          <label className="summary-field">
            <span>Zusammenfassungsmodell</span>
            <select
              value={selectedModel}
              onChange={event => setSelectedModel(event.target.value)}
              disabled={busy}
            >
              {models.map(model => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </label>

          <p className="summary-cost-warning">
            Verwendet das gewählte Modell und kann API-Kosten verursachen.
            Das Modell des Zielchats bleibt unverändert.
          </p>

          {generationPlan && (
            <div className="summary-plan" role="status">
              Bis zu {generationPlan.calls} Modellaufruf{generationPlan.calls === 1 ? '' : 'e'} · {generationPlan.mode === 'chunked' ? 'langer Verlauf mit Teilzusammenfassungen' : 'ein vollständiger Snapshot'}
            </div>
          )}

          {planError && (
            <div className="summary-alert summary-alert-error">{planError.message}</div>
          )}
          {(activeRun || chatBusy) && (
            <div className="summary-alert">
              Im Quellchat läuft noch eine Antwort oder Tool-Aktion. Danach kann die Zusammenfassung erstellt oder übernommen werden.
            </div>
          )}
          {messageCount === 0 && !loading && (
            <div className="summary-alert">Ein leerer Chat kann nicht zusammengefasst werden.</div>
          )}
          {stale && (
            <div className="summary-alert summary-alert-error">
              Der Quellchat wurde seit diesem Entwurf verändert. Erstelle eine neue Zusammenfassung; deine aktuelle Bearbeitung bleibt hier sichtbar.
            </div>
          )}
          {error && <div className="summary-alert summary-alert-error" role="alert">{error}</div>}
          {notice && <div className="summary-alert summary-alert-success" role="status">{notice}</div>}
          {cost && <div className="summary-cost-result">{formatCost(cost)}</div>}

          <div className="summary-generate-row">
            <button
              type="button"
              className="summary-button summary-button-primary"
              onClick={generateSummary}
              disabled={generateDisabled}
            >
              {generating ? 'Zusammenfassung läuft …' : revision != null ? 'Neu erstellen' : 'Zusammenfassung erstellen'}
            </button>
            {generating && (
              <button
                type="button"
                className="summary-button"
                onClick={cancelGeneration}
                disabled={cancelling}
              >
                {cancelling ? 'Abbruch läuft …' : 'Abbrechen'}
              </button>
            )}
          </div>

          <label className="summary-field summary-editor-field">
            <span>Zusammenfassung (Markdown)</span>
            <textarea
              value={content}
              onChange={event => setContent(event.target.value)}
              disabled={revision == null || generating}
              maxLength={20000}
              placeholder={loading ? 'Entwurf wird geladen …' : 'Erstelle zuerst eine Zusammenfassung.'}
            />
            <span className="summary-character-count">{content.length.toLocaleString('de-DE')} / 20.000 Zeichen</span>
          </label>
        </div>

        <footer className="summary-dialog-footer">
          <button
            type="button"
            className="summary-button"
            disabled={saveDisabled}
            onClick={saveSummary}
          >
            {saving ? 'Speichert …' : 'Speichern'}
          </button>
          <button
            type="button"
            className="summary-button"
            disabled={!content.trim() || busy}
            onClick={copySummary}
          >
            Kopieren
          </button>
          <button
            type="button"
            className="summary-button summary-button-primary summary-continue-button"
            disabled={continueDisabled}
            onClick={continueInNewChat}
          >
            {continuing ? 'Neuer Chat wird erstellt …' : 'In neuem Chat fortsetzen'}
          </button>
        </footer>
      </section>
    </div>
  )
}
