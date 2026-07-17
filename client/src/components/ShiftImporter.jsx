import {
  useEffect,
  useMemo,
  useState
} from 'react'

import api from '../lib/api.js'
import ShiftSettings from './ShiftSettings.jsx'
import ShiftHistory from './ShiftHistory.jsx'

const PRESETS = {
  '1': {
    startTime: '04:00',
    endTime: '12:00',
    title: 'Frühschicht'
  },
  '2': {
    startTime: '12:00',
    endTime: '20:00',
    title: 'Spätschicht'
  },
  '3': {
    startTime: '20:00',
    endTime: '04:00',
    title: 'Nachtschicht'
  }
}

const CODES = [
  '',
  '1',
  '2',
  '3',
  'F',
  'X',
  'P',
  'K',
  'S',
  'N'
]

const ACTIONABLE = new Set([
  'create',
  'update',
  'delete'
])


function applyProfileToItems(items, profile) {
  if (!profile?.codes) return items

  return items.map(item => {
    const preset = profile.codes[item.code]

    if (!preset) return item

    return {
      ...item,
      title: preset.title,
      startTime: preset.startTime,
      endTime: preset.endTime
    }
  })
}

async function responseError(response) {
  const data = await response
    .json()
    .catch(() => ({}))

  return new Error(
    data?.error ||
    `HTTP ${response.status}`
  )
}

function confidence(value) {
  const number = Number(value)

  return Number.isFinite(number)
    ? `${Math.round(number * 100)} %`
    : '–'
}

function statusText(status) {
  if (status === 'created') return 'Importiert'
  if (status === 'duplicate') return 'Vorhanden'
  if (status === 'error') return 'Fehler'
  return ''
}

function actionLabel(type) {
  if (type === 'create') return 'Neu'
  if (type === 'update') return 'Ändern'
  if (type === 'delete') return 'Entfernt'
  if (type === 'unchanged') return 'Unverändert'
  if (type === 'manual_existing') {
    return 'Manuell vorhanden'
  }
  if (type === 'conflict') return 'Konflikt'
  return type
}

function actionColor(type) {
  if (type === 'create') return 'var(--green)'
  if (type === 'update') return 'var(--accent)'
  if (type === 'delete') return 'var(--danger)'
  if (type === 'conflict') return 'var(--danger)'
  return 'var(--text3)'
}

function runStatusText(status) {
  if (status === 'draft') return 'Vorschau'
  if (status === 'applied') return 'Synchronisiert'
  if (status === 'partial') {
    return 'Teilweise synchronisiert'
  }
  if (status === 'rolled_back') return 'Rückgängig'
  if (status === 'rollback_partial') {
    return 'Teilweise rückgängig'
  }
  return status || ''
}

function formatEvent(event) {
  if (!event) return '–'

  const timeZone =
    event.timeZone ||
    'Europe/Vienna'

  const start = event.start
    ? new Date(event.start)
        .toLocaleString(
          'de-AT',
          {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone
          }
        )
    : '–'

  const end = event.end
    ? new Date(event.end)
        .toLocaleString(
          'de-AT',
          {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone
          }
        )
    : '–'

  return `${event.title} · ${start}–${end}`
}

export default function ShiftImporter({
  onClose
}) {
  const [files, setFiles] = useState([])
  const [analysisProgress, setAnalysisProgress] =
    useState(null)
  const [columnNumber, setColumnNumber] =
    useState(1)
  const [draft, setDraft] = useState(null)
  const [items, setItems] = useState([])
  const [syncRun, setSyncRun] = useState(null)
  const [actions, setActions] = useState([])
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] =
    useState(false)
  const [saving, setSaving] = useState(false)
  const [comparing, setComparing] =
    useState(false)
  const [syncing, setSyncing] = useState(false)
  const [rollingBack, setRollingBack] =
    useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState(null)
  const [showUnchanged, setShowUnchanged] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [showPlan, setShowPlan] = useState(true)
  const [profile, setProfile] = useState(null)
  const [showProfile, setShowProfile] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    let alive = true

    api.get('/api/shift-settings')
      .then(data => {
        if (alive) setProfile(data)
      })
      .catch(() => {})

    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true

    api.get('/api/shift-imports/latest')
      .then(async data => {
        if (!alive || !data?.import) return

        setDraft(data.import)
        setItems(data.items || [])
        setColumnNumber(
          data.import.columnNumber || 1
        )

        try {
          const sync = await api.get(
            `/api/shift-sync/imports/${data.import.id}/latest`
          )

          if (!alive || !sync?.run) return

          setSyncRun(sync.run)
          setActions(sync.actions || [])
          setSummary(sync.run.summary || null)
          setShowUnchanged(false)
          setShowCompleted(false)
          setShowPlan(
            ![
              'applied',
              'partial',
              'rolled_back',
              'rollback_partial'
            ].includes(sync.run.status)
          )
        } catch {
          // Kein früherer Vergleich ist normal.
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [])

  const enabledCount = useMemo(
    () =>
      items.filter(item => item.enabled)
        .length,
    [items]
  )

  const uncertainCount = useMemo(
    () =>
      items.filter(item =>
        Number(item.confidence) < 0.85
      ).length,
    [items]
  )

  const selectedActionCount = useMemo(
    () =>
      actions.filter(
        action =>
          ACTIONABLE.has(
            action.actionType
          ) &&
          action.selected
      ).length,
    [actions]
  )

  const hiddenInfoCount = useMemo(
    () =>
      actions.filter(action =>
        action.actionType === 'unchanged' ||
        action.actionType === 'manual_existing'
      ).length,
    [actions]
  )

  const completedCount = useMemo(
    () =>
      actions.filter(action =>
        action.status === 'applied' ||
        action.status === 'rolled_back'
      ).length,
    [actions]
  )

  const visibleActions = useMemo(
    () =>
      actions.filter(action => {
        const informational =
          action.actionType === 'unchanged' ||
          action.actionType === 'manual_existing'

        const completed =
          action.status === 'applied' ||
          action.status === 'rolled_back'

        if (!showUnchanged && informational) {
          return false
        }

        if (!showCompleted && completed) {
          return false
        }

        return true
      }),
    [
      actions,
      showUnchanged,
      showCompleted
    ]
  )

  function clearComparison() {
    setSyncRun(null)
    setActions([])
    setSummary(null)
  }

  function updateItem(id, patch) {
    setItems(previous =>
      previous.map(item =>
        item.id === id
          ? {
              ...item,
              ...patch
            }
          : item
      )
    )

    clearComparison()
  }

  function changeCode(item, code) {
    const preset =
      profile?.codes?.[code] ||
      PRESETS[code]

    updateItem(
      item.id,
      preset
        ? {
            code,
            ...preset,
            enabled:
              Number(item.confidence) >= 0.85
          }
        : {
            code,
            enabled: false
          }
    )
  }

  function setActionSelected(id, selected) {
    setActions(previous =>
      previous.map(action =>
        action.id === id
          ? {
              ...action,
              selected
            }
          : action
      )
    )
  }

  function moveSelectedFile(
    index,
    direction
  ) {
    setFiles(previous => {
      const next = [...previous]
      const target = index + direction

      if (
        target < 0 ||
        target >= next.length
      ) {
        return previous
      }

      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  function removeSelectedFile(index) {
    setFiles(previous =>
      previous.filter(
        (_, itemIndex) =>
          itemIndex !== index
      )
    )
  }

  async function analyze(event) {
    event.preventDefault()

    if (files.length === 0) {
      setError(
        'Bitte zuerst mindestens ein Foto auswählen.'
      )
      return
    }

    setAnalyzing(true)
    setAnalysisProgress({
      current: 0,
      total: files.length
    })
    setError('')
    clearComparison()

    const createdImportIds = []

    try {
      let lastResult = null

      for (
        let index = 0;
        index < files.length;
        index += 1
      ) {
        setAnalysisProgress({
          current: index + 1,
          total: files.length
        })

        const body = new FormData()
        body.append('image', files[index])
        body.append(
          'columnNumber',
          String(columnNumber)
        )

        const response = await fetch(
          '/api/shift-imports/analyze',
          {
            method: 'POST',
            body
          }
        )

        if (!response.ok) {
          throw await responseError(response)
        }

        lastResult = await response.json()

        if (lastResult?.import?.id) {
          createdImportIds.push(
            lastResult.import.id
          )
        }
      }

      let data = lastResult

      if (createdImportIds.length > 1) {
        data = await api.post(
          '/api/shift-multipage/merge',
          {
            importIds: createdImportIds
          }
        )
      }

      setDraft(data.import)
      setItems(
        applyProfileToItems(
          data.items || [],
          profile
        )
      )
      setShowPlan(true)
      setFiles([])
    } catch (failure) {
      if (createdImportIds.length > 0) {
        try {
          await api.post(
            '/api/shift-multipage/discard',
            {
              importIds: createdImportIds
            }
          )
        } catch {}
      }

      setError(
        failure?.message ||
        'Analyse fehlgeschlagen'
      )
    } finally {
      setAnalyzing(false)
      setAnalysisProgress(null)
    }
  }

  async function saveItems() {
    if (!draft?.id) return null

    setSaving(true)
    setError('')

    try {
      const data = await api.put(
        `/api/shift-imports/${draft.id}/items`,
        { items }
      )

      setDraft(data.import)
      setItems(data.items || [])
      return data
    } catch (failure) {
      setError(
        failure?.message ||
        'Vorschau konnte nicht gespeichert werden'
      )
      return null
    } finally {
      setSaving(false)
    }
  }

  async function compareCalendar() {
    if (
      !draft?.id ||
      enabledCount === 0
    ) {
      setError(
        'Keine aktiven Schichten für den Vergleich.'
      )
      return
    }

    setComparing(true)
    setError('')
    clearComparison()

    try {
      const saved = await saveItems()
      if (!saved) return

      const data = await api.post(
        `/api/shift-sync/imports/${draft.id}/compare`,
        {
          timeZone: 'Europe/Vienna'
        }
      )

      setSyncRun(data.run)
      setActions(data.actions || [])
      setSummary(data.run?.summary || null)
      setShowUnchanged(false)
    } catch (failure) {
      setError(
        failure?.message ||
        'Kalendervergleich fehlgeschlagen'
      )
    } finally {
      setComparing(false)
    }
  }

  async function applySync() {
    if (
      !syncRun?.id ||
      selectedActionCount === 0
    ) {
      setError(
        'Keine Kalenderänderungen ausgewählt.'
      )
      return
    }

    setSyncing(true)
    setError('')

    try {
      const selectedActionIds = actions
        .filter(
          action =>
            ACTIONABLE.has(
              action.actionType
            ) &&
            action.selected
        )
        .map(action => action.id)

      const data = await api.post(
        `/api/shift-sync/runs/${syncRun.id}/apply`,
        {
          selectedActionIds
        }
      )

      setSyncRun(data.run)
      setActions(data.actions || [])
      setSummary(
        data.summary ||
        data.run?.summary ||
        null
      )
      setShowCompleted(false)
      setShowPlan(false)

      const refreshed = await api.get(
        `/api/shift-imports/${draft.id}`
      )

      setDraft(refreshed.import)
      setItems(refreshed.items || [])
    } catch (failure) {
      setError(
        failure?.message ||
        'Kalendersynchronisation fehlgeschlagen'
      )
    } finally {
      setSyncing(false)
    }
  }

  async function rollbackSync() {
    if (!syncRun?.id) return

    const accepted = window.confirm(
      'Diesen Lauf wirklich rückgängig machen? Später manuell veränderte Termine werden aus Sicherheitsgründen nicht überschrieben.'
    )

    if (!accepted) return

    setRollingBack(true)
    setError('')

    try {
      const data = await api.post(
        `/api/shift-sync/runs/${syncRun.id}/rollback`,
        {}
      )

      setSyncRun(data.run)
      setActions(data.actions || [])
      setSummary(
        data.summary ||
        data.run?.summary ||
        null
      )
    } catch (failure) {
      setError(
        failure?.message ||
        'Rückgängig fehlgeschlagen'
      )
    } finally {
      setRollingBack(false)
    }
  }

  function handleProfileSaved(nextProfile) {
    setProfile(nextProfile)
    setItems(previous =>
      applyProfileToItems(
        previous,
        nextProfile
      )
    )
    setShowProfile(false)
    setShowPlan(true)
    clearComparison()
  }

  async function loadHistoryPlan(importId) {
    setLoading(true)
    setError('')

    try {
      const data = await api.get(
        `/api/shift-imports/${importId}`
      )

      setDraft(data.import)
      setItems(data.items || [])
      setColumnNumber(
        data.import?.columnNumber || 1
      )
      setFiles([])
      clearComparison()
      setShowPlan(true)

      try {
        const sync = await api.get(
          `/api/shift-sync/imports/${importId}/latest`
        )

        if (sync?.run) {
          setSyncRun(sync.run)
          setActions(sync.actions || [])
          setSummary(sync.run.summary || null)
          setShowUnchanged(false)
          setShowCompleted(false)
          setShowPlan(
            ![
              'applied',
              'partial',
              'rolled_back',
              'rollback_partial'
            ].includes(sync.run.status)
          )
        }
      } catch {
        // Ein Plan ohne Sync-Lauf ist ein normaler Entwurf.
      }

      setShowHistory(false)
    } catch (failure) {
      setError(
        failure?.message ||
        'Schichtplan konnte nicht geöffnet werden'
      )
      throw failure
    } finally {
      setLoading(false)
    }
  }

  function handleHistoryPlanUnavailable(planId) {
    if (draft?.id === planId) {
      setDraft(null)
      setItems([])
      setFile(null)
      setShowPlan(true)
      clearComparison()
    }
  }

  function startNew() {
    setDraft(null)
    setItems([])
    setFile(null)
    setShowPlan(true)
    clearComparison()
    setError('')
  }

  const runEditable =
    !syncRun ||
    syncRun.status === 'draft'

  return (
    <>
      <div
        style={styles.backdrop}
        onClick={onClose}
      />

      <section style={styles.panel}>
        <header style={styles.header}>
          <div style={styles.headerText}>
            <h2 style={styles.title}>
              Schichtplan synchronisieren
            </h2>

            <p style={styles.subtitle}>
              Foto prüfen, Kalender vergleichen und
              Änderungen gesammelt anwenden.
            </p>
          </div>

          <div style={styles.headerActions}>
            <button
              type="button"
              onClick={() => {
                setShowHistory(value => !value)
                setShowProfile(false)
              }}
              style={styles.profileButton}
            >
              Pläne
            </button>

            <button
              type="button"
              onClick={() => {
                setShowProfile(value => !value)
                setShowHistory(false)
              }}
              style={styles.profileButton}
            >
              Profil
            </button>

            <button
              type="button"
              onClick={onClose}
              style={styles.close}
              aria-label="Schließen"
            >
              ×
            </button>
          </div>
        </header>

        <div style={styles.body}>
          {showHistory && (
            <ShiftHistory
              onClose={() => setShowHistory(false)}
              onOpenPlan={loadHistoryPlan}
              onPlanUnavailable={handleHistoryPlanUnavailable}
            />
          )}

          {showProfile && profile && (
            <ShiftSettings
              profile={profile}
              onSaved={handleProfileSaved}
              onClose={() => setShowProfile(false)}
            />
          )}

          {loading ? (
            <div style={styles.loading}>
              Letzten Entwurf laden …
            </div>
          ) : !draft ? (
            <form
              onSubmit={analyze}
              style={styles.uploadCard}
            >
              <label style={styles.label}>
                Schichtplanfotos

                <span style={styles.filePicker}>
                  <span style={styles.fileButton}>
                    Fotos auswählen
                  </span>

                  <span style={styles.fileName}>
                    {files.length > 0
                      ? `${files.length} Foto${
                          files.length === 1
                            ? ''
                            : 's'
                        } ausgewählt`
                      : 'Keine Datei ausgewählt'}
                  </span>

                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    onChange={event =>
                      setFiles(
                        Array.from(
                          event.target.files || []
                        ).slice(0, 10)
                      )
                    }
                    style={styles.hiddenFileInput}
                  />
                </span>
              </label>

              {files.length > 0 && (
                <div style={styles.selectedFiles}>
                  {files.map((item, index) => (
                    <div
                      key={`${item.name}-${item.size}-${index}`}
                      style={styles.selectedFile}
                    >
                      <div style={styles.selectedFileText}>
                        <strong>
                          Seite {index + 1}
                        </strong>

                        <span style={styles.selectedFileName}>
                          {item.name}
                        </span>
                      </div>

                      <div style={styles.fileActions}>
                        <button
                          type="button"
                          onClick={() =>
                            moveSelectedFile(
                              index,
                              -1
                            )
                          }
                          disabled={index === 0}
                          style={styles.fileAction}
                          aria-label="Foto nach oben"
                        >
                          ↑
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            moveSelectedFile(
                              index,
                              1
                            )
                          }
                          disabled={
                            index ===
                            files.length - 1
                          }
                          style={styles.fileAction}
                          aria-label="Foto nach unten"
                        >
                          ↓
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            removeSelectedFile(
                              index
                            )
                          }
                          style={styles.fileAction}
                        >
                          Entfernen
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <label style={styles.label}>
                Meine Mitarbeiterspalte

                <input
                  type="number"
                  min="1"
                  max="100"
                  value={columnNumber}
                  onChange={event =>
                    setColumnNumber(
                      Math.max(
                        1,
                        Number(
                          event.target.value
                        ) || 1
                      )
                    )
                  }
                  style={styles.smallInput}
                />
              </label>

              <div style={styles.hint}>
                Spalte 1 ist die erste
                Mitarbeiterspalte direkt rechts von
                Datum und Tag. Bis zu zehn Fotos
                werden in der angezeigten Reihenfolge
                analysiert und anschließend zu einem
                Plan zusammengeführt. Widersprüche
                werden deaktiviert und markiert.
              </div>

              <button
                type="submit"
                disabled={analyzing || files.length === 0}
                style={{
                  ...styles.primary,
                  width: '100%',
                  opacity:
                    analyzing ||
                    files.length === 0
                      ? 0.55
                      : 1
                }}
              >
                {analyzing
                  ? analysisProgress
                    ? `Foto ${analysisProgress.current} von ${analysisProgress.total} wird analysiert …`
                    : 'Fotos werden analysiert …'
                  : files.length > 1
                    ? `${files.length} Fotos analysieren`
                    : 'Vorschau erstellen'}
              </button>
            </form>
          ) : (
            <>
              <div style={styles.summaryCard}>
                <div style={styles.summaryText}>
                  <strong>
                    {draft.originalName}
                  </strong>

                  <div style={styles.muted}>
                    Spalte {draft.columnNumber}
                    {' · '}
                    {draft.planStart || '–'}
                    {' bis '}
                    {draft.planEnd || '–'}
                    {' · '}
                    {draft.model || '–'}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={startNew}
                  style={styles.secondary}
                >
                  Neuer Plan
                </button>
              </div>

              <div style={styles.planBar}>
                <div style={styles.planBarText}>
                  <strong>
                    {items.length} Planzeilen gespeichert
                  </strong>

                  <div style={styles.muted}>
                    {enabledCount} aktive Schichten
                    {' · '}
                    {uncertainCount} unsicher
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    setShowPlan(value => !value)
                  }
                  style={styles.secondary}
                >
                  {showPlan
                    ? 'Plan einklappen'
                    : 'Plan anzeigen/bearbeiten'}
                </button>
              </div>

              {showPlan && (
                <>
                  {draft.warnings?.length > 0 && (
                <div style={styles.warning}>
                  {draft.warnings.map(
                    (text, index) => (
                      <div key={index}>
                        {text}
                      </div>
                    )
                  )}
                </div>
              )}

              <div style={styles.stats}>
                <span>
                  {items.length} Datumszeilen
                </span>
                <span>
                  {enabledCount} aktiv
                </span>
                <span>
                  {uncertainCount} unsicher
                </span>
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {[
                        'Aktiv',
                        'Datum',
                        'Code',
                        'Beginn',
                        'Ende',
                        'Titel',
                        'Sicherheit',
                        'Hinweis',
                        'Status'
                      ].map(label => (
                        <th
                          key={label}
                          style={styles.th}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {items.map(item => {
                      const supported =
                        Boolean(
                          PRESETS[item.code]
                        )

                      const uncertain =
                        Number(item.confidence) <
                        0.85

                      return (
                        <tr
                          key={item.id}
                          style={
                            uncertain
                              ? styles.uncertain
                              : undefined
                          }
                        >
                          <td style={styles.td}>
                            <input
                              type="checkbox"
                              checked={item.enabled}
                              disabled={!supported}
                              onChange={event =>
                                updateItem(
                                  item.id,
                                  {
                                    enabled:
                                      event.target
                                        .checked
                                  }
                                )
                              }
                            />
                          </td>

                          <td style={styles.td}>
                            <input
                              type="date"
                              value={item.workDate}
                              onChange={event =>
                                updateItem(
                                  item.id,
                                  {
                                    workDate:
                                      event.target
                                        .value
                                  }
                                )
                              }
                              style={styles.input}
                            />
                          </td>

                          <td style={styles.td}>
                            <select
                              value={item.code}
                              onChange={event =>
                                changeCode(
                                  item,
                                  event.target.value
                                )
                              }
                              style={styles.input}
                            >
                              {!CODES.includes(
                                item.code
                              ) && (
                                <option
                                  value={item.code}
                                >
                                  {item.code}
                                </option>
                              )}

                              {CODES.map(code => (
                                <option
                                  key={
                                    code || 'empty'
                                  }
                                  value={code}
                                >
                                  {code || '–'}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td style={styles.td}>
                            <input
                              type="time"
                              value={
                                item.startTime || ''
                              }
                              onChange={event =>
                                updateItem(
                                  item.id,
                                  {
                                    startTime:
                                      event.target
                                        .value
                                  }
                                )
                              }
                              style={styles.input}
                            />
                          </td>

                          <td style={styles.td}>
                            <input
                              type="time"
                              value={
                                item.endTime || ''
                              }
                              onChange={event =>
                                updateItem(
                                  item.id,
                                  {
                                    endTime:
                                      event.target
                                        .value
                                  }
                                )
                              }
                              style={styles.input}
                            />
                          </td>

                          <td style={styles.td}>
                            <input
                              type="text"
                              value={item.title || ''}
                              onChange={event =>
                                updateItem(
                                  item.id,
                                  {
                                    title:
                                      event.target
                                        .value
                                  }
                                )
                              }
                              style={{
                                ...styles.input,
                                minWidth: 130
                              }}
                            />
                          </td>

                          <td
                            style={{
                              ...styles.td,
                              color: uncertain
                                ? 'var(--danger)'
                                : 'var(--text2)'
                            }}
                          >
                            {confidence(
                              item.confidence
                            )}
                          </td>

                          <td style={styles.td}>
                            <textarea
                              rows="2"
                              value={item.note || ''}
                              onChange={event =>
                                updateItem(
                                  item.id,
                                  {
                                    note:
                                      event.target
                                        .value
                                  }
                                )
                              }
                              style={{
                                ...styles.input,
                                minWidth: 180,
                                resize: 'vertical'
                              }}
                            />
                          </td>

                          <td style={styles.td}>
                            <span
                              style={{
                                color:
                                  item.importStatus ===
                                  'error'
                                    ? 'var(--danger)'
                                    : item.importStatus ===
                                        'created'
                                      ? 'var(--green)'
                                      : 'var(--text3)'
                              }}
                            >
                              {statusText(
                                item.importStatus
                              )}
                            </span>

                            {item.error && (
                              <div
                                style={styles.rowError}
                              >
                                {item.error}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

                </>
              )}

              <div style={styles.footer}>
                {showPlan && (
                  <button
                    type="button"
                    onClick={saveItems}
                    disabled={
                      saving ||
                      comparing ||
                      syncing
                    }
                    style={styles.secondary}
                  >
                    {saving
                      ? 'Speichert …'
                      : 'Vorschau speichern'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={compareCalendar}
                  disabled={
                    saving ||
                    comparing ||
                    syncing ||
                    enabledCount === 0
                  }
                  style={{
                    ...styles.primary,
                    opacity:
                      saving ||
                      comparing ||
                      syncing ||
                      enabledCount === 0
                        ? 0.55
                        : 1
                  }}
                >
                  {comparing
                    ? 'Kalender wird verglichen …'
                    : syncRun
                      ? 'Neu abgleichen'
                      : 'Kalender abgleichen'}
                </button>
              </div>

              {syncRun && (
                <section style={styles.syncSection}>
                  <div style={styles.syncHeader}>
                    <div>
                      <h3 style={styles.syncTitle}>
                        Kalendervergleich
                      </h3>

                      <div style={styles.muted}>
                        {runStatusText(
                          syncRun.status
                        )}
                        {' · '}
                        Lauf #{syncRun.id}
                      </div>
                    </div>

                    {['applied', 'partial'].includes(
                      syncRun.status
                    ) && (
                      <button
                        type="button"
                        onClick={rollbackSync}
                        disabled={rollingBack}
                        style={styles.dangerButton}
                      >
                        {rollingBack
                          ? 'Macht rückgängig …'
                          : 'Lauf rückgängig'}
                      </button>
                    )}
                  </div>

                  {summary && (
                    <div style={styles.syncStats}>
                      {'create' in summary && (
                        <span>
                          {summary.create} neu
                        </span>
                      )}
                      {'update' in summary && (
                        <span>
                          {summary.update} ändern
                        </span>
                      )}
                      {'delete' in summary && (
                        <span>
                          {summary.delete} entfernt
                        </span>
                      )}
                      {'unchanged' in summary && (
                        <span>
                          {summary.unchanged} gleich
                        </span>
                      )}
                      {'manualExisting' in summary && (
                        <span>
                          {summary.manualExisting} manuell vorhanden
                        </span>
                      )}
                      {'conflicts' in summary && (
                        <span>
                          {summary.conflicts} Konflikte
                        </span>
                      )}
                      {'created' in summary && (
                        <span>
                          {summary.created} erstellt
                        </span>
                      )}
                      {'updated' in summary && (
                        <span>
                          {summary.updated} aktualisiert
                        </span>
                      )}
                      {'deleted' in summary && (
                        <span>
                          {summary.deleted} gelöscht
                        </span>
                      )}
                      {'errors' in summary && (
                        <span>
                          {summary.errors} Fehler
                        </span>
                      )}
                      {'rolledBack' in summary && (
                        <span>
                          {summary.rolledBack} rückgängig
                        </span>
                      )}
                    </div>
                  )}

                  {summary?.warnings?.length > 0 && (
                    <div style={styles.warning}>
                      {summary.warnings.map(
                        (text, index) => (
                          <div key={index}>
                            {text}
                          </div>
                        )
                      )}
                    </div>
                  )}

                  {(hiddenInfoCount > 0 ||
                    completedCount > 0) && (
                    <div style={styles.filterRow}>
                      {completedCount > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setShowCompleted(value => !value)
                          }
                          style={styles.infoToggle}
                        >
                          {showCompleted
                            ? `${completedCount} erledigte Änderungen ausblenden`
                            : `${completedCount} erledigte Änderungen anzeigen`}
                        </button>
                      )}

                      {hiddenInfoCount > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setShowUnchanged(value => !value)
                          }
                          style={styles.infoToggle}
                        >
                          {showUnchanged
                            ? `${hiddenInfoCount} unveränderte Einträge ausblenden`
                            : `${hiddenInfoCount} unveränderte Einträge anzeigen`}
                        </button>
                      )}
                    </div>
                  )}

                  {visibleActions.length === 0 && (
                    <div style={styles.allDone}>
                      Alle Kalenderänderungen dieses Laufs sind erledigt.
                    </div>
                  )}

                  <div style={styles.actionList}>
                    {visibleActions.map(action => {
                      const actionable =
                        ACTIONABLE.has(
                          action.actionType
                        )

                      const canSelect =
                        actionable &&
                        runEditable &&
                        action.status ===
                          'pending'

                      return (
                        <article
                          key={action.id}
                          style={styles.actionCard}
                        >
                          <div
                            style={styles.actionTop}
                          >
                            <div
                              style={styles.actionChoice}
                            >
                              {canSelect ? (
                                <input
                                  type="checkbox"
                                  checked={
                                    action.selected
                                  }
                                  disabled={!canSelect}
                                  onChange={event =>
                                    setActionSelected(
                                      action.id,
                                      event.target
                                        .checked
                                    )
                                  }
                                />
                              ) : (
                                <span
                                  aria-hidden="true"
                                  style={styles.infoDot}
                                />
                              )}

                              <strong
                                style={{
                                  color:
                                    actionColor(
                                      action.actionType
                                    )
                                }}
                              >
                                {actionLabel(
                                  action.actionType
                                )}
                              </strong>
                            </div>

                            <span style={styles.dateBadge}>
                              {action.workDate}
                            </span>
                          </div>

                          {action.oldEvent && (
                            <div
                              style={styles.eventLine}
                            >
                              <span
                                style={styles.eventKey}
                              >
                                Kalender
                              </span>
                              <span>
                                {formatEvent(
                                  action.oldEvent
                                )}
                              </span>
                            </div>
                          )}

                          {action.newEvent && (
                            <div
                              style={styles.eventLine}
                            >
                              <span
                                style={styles.eventKey}
                              >
                                Plan
                              </span>
                              <span>
                                {formatEvent(
                                  action.newEvent
                                )}
                              </span>
                            </div>
                          )}

                          <div style={styles.actionMessage}>
                            {action.message}
                          </div>

                          {action.status !==
                            'pending' && (
                            <div
                              style={styles.actionStatus}
                            >
                              Status: {action.status}
                            </div>
                          )}

                          {action.error && (
                            <div style={styles.rowError}>
                              {action.error}
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>

                  {runEditable && (
                    <div style={styles.footer}>
                      <div style={styles.safetyText}>
                        Löschungen sind standardmäßig
                        aus. Manuelle Konflikte werden
                        nie automatisch verändert.
                      </div>

                      <button
                        type="button"
                        onClick={applySync}
                        disabled={
                          syncing ||
                          selectedActionCount === 0
                        }
                        style={{
                          ...styles.primary,
                          opacity:
                            syncing ||
                            selectedActionCount === 0
                              ? 0.55
                              : 1
                        }}
                      >
                        {syncing
                          ? 'Synchronisiert …'
                          : `${selectedActionCount} Änderungen anwenden`}
                      </button>
                    </div>
                  )}
                </section>
              )}

              <div style={styles.hint}>
                Exakt passende manuelle Termine
                bleiben unangetastet. Abweichende
                manuelle Schichttermine erscheinen
                als Konflikt und werden nicht
                automatisch geändert.
              </div>
            </>
          )}

          {error && (
            <div style={styles.error}>
              {error}
            </div>
          )}
        </div>
      </section>
    </>
  )
}

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 110,
    background: 'rgba(0,0,0,0.7)'
  },
  panel: {
    position: 'fixed',
    zIndex: 111,
    inset:
      'max(10px, env(safe-area-inset-top)) 10px max(10px, env(safe-area-inset-bottom))',
    maxWidth: 1180,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    border: '1px solid var(--border)',
    borderRadius: 14,
    background: 'var(--bg2)',
    boxShadow:
      '0 24px 70px rgba(0,0,0,0.55)'
  },
  header: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '16px 18px',
    borderBottom: '1px solid var(--border)'
  },
  headerText: {
    minWidth: 0
  },
  headerActions: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 7
  },
  profileButton: {
    padding: '7px 9px',
    border: '1px solid var(--border)',
    borderRadius: 7,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 11
  },
  title: {
    margin: 0,
    fontSize: 18,
    color: 'var(--text)'
  },
  subtitle: {
    margin: '5px 0 0',
    color: 'var(--text3)',
    fontSize: 12,
    lineHeight: 1.35
  },
  close: {
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: 8,
    color: 'var(--text2)',
    background: 'var(--bg3)',
    fontSize: 22,
    lineHeight: 1
  },
  body: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: 16,
    boxSizing: 'border-box'
  },
  loading: {
    padding: 40,
    textAlign: 'center',
    color: 'var(--text3)'
  },
  uploadCard: {
    width: '100%',
    maxWidth: 520,
    minWidth: 0,
    margin: '20px auto',
    padding: 18,
    boxSizing: 'border-box',
    overflow: 'hidden',
    display: 'grid',
    gap: 15,
    border: '1px solid var(--border)',
    borderRadius: 12,
    background: 'var(--bg3)'
  },
  label: {
    display: 'grid',
    minWidth: 0,
    gap: 7,
    color: 'var(--text2)',
    fontSize: 12,
    fontWeight: 600
  },
  selectedFiles: {
    display: 'grid',
    gap: 7,
    minWidth: 0
  },
  selectedFile: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    padding: 8,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg2)'
  },
  selectedFileText: {
    minWidth: 0,
    flex: '1 1 180px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text2)',
    fontSize: 11
  },
  selectedFileName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text3)'
  },
  fileActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 5
  },
  fileAction: {
    minHeight: 30,
    padding: '5px 8px',
    border: '1px solid var(--border)',
    borderRadius: 7,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 11
  },
  filePicker: {
    position: 'relative',
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    minHeight: 44,
    boxSizing: 'border-box',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: 6,
    border: '1px solid var(--border)',
    borderRadius: 9,
    background: 'var(--bg2)',
    cursor: 'pointer'
  },
  fileButton: {
    flexShrink: 0,
    padding: '7px 10px',
    borderRadius: 7,
    background: 'var(--bg3)',
    color: 'var(--text)',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap'
  },
  fileName: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text3)',
    fontSize: 12,
    fontWeight: 400
  },
  hiddenFileInput: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    opacity: 0,
    cursor: 'pointer'
  },
  smallInput: {
    width: 100,
    maxWidth: '100%',
    padding: '9px 10px',
    boxSizing: 'border-box',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg2)',
    color: 'var(--text)'
  },
  hint: {
    marginTop: 10,
    color: 'var(--text3)',
    fontSize: 10,
    lineHeight: 1.5
  },
  summaryCard: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: 12,
    border: '1px solid var(--border)',
    borderRadius: 10,
    background: 'var(--bg3)'
  },
  summaryText: {
    minWidth: 0,
    overflowWrap: 'anywhere'
  },
  muted: {
    marginTop: 4,
    color: 'var(--text3)',
    fontSize: 11
  },
  planBar: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 10,
    padding: 11,
    border: '1px solid var(--border)',
    borderRadius: 10,
    background: 'var(--bg3)'
  },
  planBarText: {
    minWidth: 0,
    color: 'var(--text)',
    fontSize: 12
  },
  stats: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    margin: '12px 0',
    color: 'var(--text2)',
    fontSize: 11,
    fontFamily: 'var(--font-mono)'
  },
  tableWrap: {
    maxWidth: '100%',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    border: '1px solid var(--border)',
    borderRadius: 10
  },
  table: {
    width: 'max-content',
    minWidth: '100%',
    borderCollapse: 'collapse',
    background: 'var(--bg2)'
  },
  th: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    padding: '9px 8px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg3)',
    color: 'var(--text3)',
    fontSize: 10,
    textAlign: 'left',
    whiteSpace: 'nowrap'
  },
  td: {
    padding: 6,
    borderBottom: '1px solid var(--border)',
    color: 'var(--text2)',
    fontSize: 11,
    verticalAlign: 'top'
  },
  uncertain: {
    background: 'rgba(255,90,90,0.045)'
  },
  input: {
    minWidth: 90,
    maxWidth: 240,
    padding: '7px 8px',
    border: '1px solid var(--border)',
    borderRadius: 7,
    background: 'var(--bg3)',
    color: 'var(--text)',
    fontSize: 12
  },
  rowError: {
    marginTop: 4,
    maxWidth: 280,
    color: 'var(--danger)',
    fontSize: 10,
    overflowWrap: 'anywhere'
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14
  },
  primary: {
    minWidth: 0,
    maxWidth: '100%',
    padding: '10px 14px',
    boxSizing: 'border-box',
    borderRadius: 8,
    background: 'var(--accent)',
    color: '#0d0d0d',
    fontWeight: 700,
    fontSize: 12
  },
  secondary: {
    padding: '9px 12px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 12
  },
  dangerButton: {
    padding: '8px 10px',
    border: '1px solid rgba(255,80,80,0.35)',
    borderRadius: 8,
    background: 'rgba(255,80,80,0.08)',
    color: 'var(--danger)',
    fontSize: 11
  },
  warning: {
    marginTop: 10,
    padding: 10,
    border: '1px solid rgba(230,180,70,0.35)',
    borderRadius: 9,
    background: 'rgba(230,180,70,0.08)',
    color: 'var(--text2)',
    fontSize: 11,
    lineHeight: 1.5
  },
  error: {
    marginTop: 12,
    padding: 10,
    border: '1px solid rgba(255,80,80,0.3)',
    borderRadius: 9,
    background: 'rgba(255,80,80,0.08)',
    color: 'var(--danger)',
    fontSize: 12
  },
  syncSection: {
    marginTop: 18,
    paddingTop: 14,
    borderTop: '1px solid var(--border)'
  },
  syncHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10
  },
  syncTitle: {
    margin: 0,
    color: 'var(--text)',
    fontSize: 15
  },
  syncStats: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    margin: '10px 0',
    color: 'var(--text2)',
    fontSize: 10,
    fontFamily: 'var(--font-mono)'
  },
  filterRow: {
    display: 'grid',
    gap: 8,
    marginBottom: 8
  },
  infoToggle: {
    width: '100%',
    marginBottom: 8,
    padding: '9px 11px',
    boxSizing: 'border-box',
    border: '1px solid var(--border)',
    borderRadius: 9,
    background: 'var(--bg3)',
    color: 'var(--text3)',
    fontSize: 11,
    textAlign: 'left'
  },
  allDone: {
    marginBottom: 8,
    padding: '12px 11px',
    border: '1px solid var(--green-dim)',
    borderRadius: 9,
    background: 'var(--green-bg)',
    color: 'var(--green)',
    fontSize: 11,
    lineHeight: 1.45
  },
  actionList: {
    display: 'grid',
    gap: 8
  },
  actionCard: {
    minWidth: 0,
    padding: 11,
    border: '1px solid var(--border)',
    borderRadius: 10,
    background: 'var(--bg3)'
  },
  actionTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10
  },
  actionChoice: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12
  },
  infoDot: {
    width: 8,
    height: 8,
    flexShrink: 0,
    borderRadius: '50%',
    background: 'var(--text3)',
    opacity: 0.45
  },
  dateBadge: {
    flexShrink: 0,
    color: 'var(--text3)',
    fontSize: 10,
    fontFamily: 'var(--font-mono)'
  },
  eventLine: {
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: '58px minmax(0, 1fr)',
    gap: 8,
    marginTop: 7,
    color: 'var(--text2)',
    fontSize: 11,
    lineHeight: 1.4,
    overflowWrap: 'anywhere'
  },
  eventKey: {
    color: 'var(--text3)'
  },
  actionMessage: {
    marginTop: 7,
    color: 'var(--text3)',
    fontSize: 10,
    lineHeight: 1.45
  },
  actionStatus: {
    marginTop: 6,
    color: 'var(--text3)',
    fontSize: 10,
    fontFamily: 'var(--font-mono)'
  },
  safetyText: {
    flex: '1 1 220px',
    color: 'var(--text3)',
    fontSize: 10,
    lineHeight: 1.45
  }
}
