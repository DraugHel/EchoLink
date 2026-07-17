import {
  useEffect,
  useState
} from 'react'

import api from '../lib/api.js'

function formatDate(value) {
  if (!value) return '–'

  const date = new Date(
    Number(value) * 1000
  )

  if (Number.isNaN(date.getTime())) {
    return '–'
  }

  return date.toLocaleString(
    'de-AT',
    {
      dateStyle: 'medium',
      timeStyle: 'short'
    }
  )
}

function planStatus(status) {
  if (status === 'draft') return 'Entwurf'
  if (status === 'imported') return 'Synchronisiert'
  if (status === 'partial') return 'Teilweise'
  return status || '–'
}

function runStatus(status) {
  if (status === 'draft') return 'Vergleich'
  if (status === 'applied') return 'Angewendet'
  if (status === 'partial') return 'Teilweise angewendet'
  if (status === 'rolled_back') return 'Rückgängig'
  if (status === 'rollback_partial') {
    return 'Teilweise rückgängig'
  }
  return status || '–'
}

function summaryParts(summary = {}) {
  const definitions = [
    ['created', 'erstellt'],
    ['updated', 'geändert'],
    ['deleted', 'gelöscht'],
    ['unchanged', 'unverändert'],
    ['manualExisting', 'manuell vorhanden'],
    ['conflicts', 'Konflikte'],
    ['errors', 'Fehler'],
    ['rolledBack', 'rückgängig'],
    ['create', 'neu'],
    ['update', 'ändern'],
    ['delete', 'entfernt']
  ]

  return definitions
    .filter(([key]) =>
      Number.isFinite(Number(summary[key])) &&
      Number(summary[key]) > 0
    )
    .map(([key, label]) =>
      `${summary[key]} ${label}`
    )
}

export default function ShiftHistory({
  onClose,
  onOpenPlan,
  onPlanUnavailable
}) {
  const [archived, setArchived] = useState(false)
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [runsByPlan, setRunsByPlan] = useState({})
  const [openRuns, setOpenRuns] = useState({})
  const [imagePlan, setImagePlan] = useState(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    loadPlans(archived)
  }, [archived])

  async function loadPlans(nextArchived) {
    setLoading(true)
    setError('')

    try {
      const data = await api.get(
        `/api/shift-history?archived=${nextArchived ? 1 : 0}`
      )

      setPlans(data.plans || [])
    } catch (failure) {
      setError(
        failure?.message ||
        'Planverlauf konnte nicht geladen werden'
      )
    } finally {
      setLoading(false)
    }
  }

  async function openPlan(plan) {
    setBusyId(plan.id)
    setError('')

    try {
      await onOpenPlan(plan.id)
      onClose()
    } catch (failure) {
      setError(
        failure?.message ||
        'Schichtplan konnte nicht geöffnet werden'
      )
    } finally {
      setBusyId(null)
    }
  }

  async function toggleArchive(plan) {
    const nextArchived = !Boolean(
      plan.archivedAt
    )

    setBusyId(plan.id)
    setError('')
    setMessage('')

    try {
      await api.post(
        `/api/shift-history/${plan.id}/archive`,
        { archived: nextArchived }
      )

      if (nextArchived) {
        onPlanUnavailable?.(plan.id)
      }

      setMessage(
        nextArchived
          ? 'Plan archiviert. Kalendereinträge bleiben erhalten.'
          : 'Plan wiederhergestellt.'
      )

      await loadPlans(archived)
    } catch (failure) {
      setError(
        failure?.message ||
        'Planstatus konnte nicht geändert werden'
      )
    } finally {
      setBusyId(null)
    }
  }

  async function deletePlan(plan) {
    const accepted = window.confirm(
      `„${plan.originalName}“ endgültig löschen? ` +
      'Plan, Originalfoto und Sync-Verlauf werden entfernt. ' +
      'Bereits angelegte Kalendereinträge bleiben unverändert.'
    )

    if (!accepted) return

    setBusyId(plan.id)
    setError('')
    setMessage('')

    try {
      await api.delete(
        `/api/shift-history/${plan.id}`
      )

      onPlanUnavailable?.(plan.id)
      setMessage(
        'Plan gelöscht. Kalendereinträge wurden nicht verändert.'
      )

      await loadPlans(archived)
    } catch (failure) {
      setError(
        failure?.message ||
        'Plan konnte nicht gelöscht werden'
      )
    } finally {
      setBusyId(null)
    }
  }

  async function toggleRuns(plan) {
    const opening = !openRuns[plan.id]

    setOpenRuns(previous => ({
      ...previous,
      [plan.id]: opening
    }))

    if (!opening || runsByPlan[plan.id]) {
      return
    }

    try {
      const data = await api.get(
        `/api/shift-history/${plan.id}/runs`
      )

      setRunsByPlan(previous => ({
        ...previous,
        [plan.id]: data.runs || []
      }))
    } catch (failure) {
      setError(
        failure?.message ||
        'Sync-Verlauf konnte nicht geladen werden'
      )
    }
  }

  async function cleanupImages() {
    setError('')
    setMessage('')

    try {
      const result = await api.post(
        '/api/shift-history/cleanup',
        {}
      )

      setMessage(
        `${result.deleted || 0} verwaiste Bilddateien entfernt.`
      )
    } catch (failure) {
      setError(
        failure?.message ||
        'Bilddateien konnten nicht bereinigt werden'
      )
    }
  }

  return (
    <section style={styles.overlay}>
      <header style={styles.header}>
        <div>
          <h3 style={styles.title}>
            Schichtpläne
          </h3>

          <div style={styles.subtitle}>
            Gespeicherte Pläne, Originalfotos und Synchronisationsläufe.
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={styles.close}
          aria-label="Planverwaltung schließen"
        >
          ×
        </button>
      </header>

      <div style={styles.toolbar}>
        <div style={styles.tabs}>
          <button
            type="button"
            onClick={() => setArchived(false)}
            style={{
              ...styles.tab,
              ...(archived
                ? {}
                : styles.activeTab)
            }}
          >
            Aktive Pläne
          </button>

          <button
            type="button"
            onClick={() => setArchived(true)}
            style={{
              ...styles.tab,
              ...(archived
                ? styles.activeTab
                : {})
            }}
          >
            Archiv
          </button>
        </div>

        <button
          type="button"
          onClick={cleanupImages}
          style={styles.subtleButton}
        >
          Bilddateien bereinigen
        </button>
      </div>

      <div style={styles.body}>
        {message && (
          <div style={styles.success}>
            {message}
          </div>
        )}

        {error && (
          <div style={styles.error}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={styles.empty}>
            Pläne werden geladen …
          </div>
        ) : plans.length === 0 ? (
          <div style={styles.empty}>
            {archived
              ? 'Keine archivierten Schichtpläne.'
              : 'Noch keine gespeicherten Schichtpläne.'}
          </div>
        ) : (
          <div style={styles.list}>
            {plans.map(plan => {
              const parts = summaryParts(
                plan.latestSyncSummary
              )

              const runs =
                runsByPlan[plan.id] || []

              return (
                <article
                  key={plan.id}
                  style={styles.card}
                >
                  <div style={styles.cardTop}>
                    <div style={styles.cardText}>
                      <strong style={styles.planName}>
                        {plan.originalName}
                      </strong>

                      <div style={styles.meta}>
                        {plan.planStart || '–'} bis{' '}
                        {plan.planEnd || '–'}
                        {' · '}
                        {planStatus(plan.status)}
                      </div>
                    </div>

                    <span style={styles.idBadge}>
                      #{plan.id}
                    </span>
                  </div>

                  <div style={styles.stats}>
                    <span>
                      {plan.totalItems} Zeilen
                    </span>
                    <span>
                      {plan.activeItems} Schichten
                    </span>
                    <span>
                      {plan.uncertainItems} unsicher
                    </span>
                    <span>
                      {plan.syncRunCount} Sync-Läufe
                    </span>
                  </div>

                  {plan.latestSyncId && (
                    <div style={styles.latestSync}>
                      <strong>
                        Letzter Lauf: {' '}
                        {runStatus(
                          plan.latestSyncStatus
                        )}
                      </strong>

                      <span style={styles.meta}>
                        {formatDate(
                          plan.latestSyncAt
                        )}
                      </span>

                      {parts.length > 0 && (
                        <div style={styles.summaryLine}>
                          {parts.join(' · ')}
                        </div>
                      )}
                    </div>
                  )}

                  <div style={styles.actions}>
                    {!plan.archivedAt && (
                      <button
                        type="button"
                        onClick={() => openPlan(plan)}
                        disabled={busyId === plan.id}
                        style={styles.primaryButton}
                      >
                        Öffnen
                      </button>
                    )}

                    {plan.hasImage && (
                      <button
                        type="button"
                        onClick={() =>
                          setImagePlan(plan)
                        }
                        style={styles.secondaryButton}
                      >
                        Originalfoto
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => toggleRuns(plan)}
                      style={styles.secondaryButton}
                    >
                      {openRuns[plan.id]
                        ? 'Sync-Verlauf schließen'
                        : 'Sync-Verlauf'}
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleArchive(plan)}
                      disabled={busyId === plan.id}
                      style={styles.secondaryButton}
                    >
                      {plan.archivedAt
                        ? 'Wiederherstellen'
                        : 'Archivieren'}
                    </button>

                    <button
                      type="button"
                      onClick={() => deletePlan(plan)}
                      disabled={busyId === plan.id}
                      style={styles.deleteButton}
                    >
                      Löschen
                    </button>
                  </div>

                  {openRuns[plan.id] && (
                    <div style={styles.runList}>
                      {!runsByPlan[plan.id] ? (
                        <div style={styles.meta}>
                          Verlauf wird geladen …
                        </div>
                      ) : runs.length === 0 ? (
                        <div style={styles.meta}>
                          Noch keine Sync-Läufe.
                        </div>
                      ) : (
                        runs.map(run => {
                          const runParts =
                            summaryParts(run.summary)

                          return (
                            <div
                              key={run.id}
                              style={styles.runCard}
                            >
                              <div style={styles.runTop}>
                                <strong>
                                  Lauf #{run.id} · {' '}
                                  {runStatus(run.status)}
                                </strong>

                                <span style={styles.meta}>
                                  {formatDate(
                                    run.rolledBackAt ||
                                    run.appliedAt ||
                                    run.createdAt
                                  )}
                                </span>
                              </div>

                              <div style={styles.summaryLine}>
                                {runParts.length > 0
                                  ? runParts.join(' · ')
                                  : `${run.actionCount} Aktionen`}
                              </div>

                              {run.errorCount > 0 && (
                                <div style={styles.runError}>
                                  {run.errorCount} Fehler
                                </div>
                              )}
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </div>

      {imagePlan && (
        <div style={styles.imageBackdrop}>
          <div style={styles.imageModal}>
            <div style={styles.imageHeader}>
              <strong>
                {imagePlan.originalName}
              </strong>

              <button
                type="button"
                onClick={() => setImagePlan(null)}
                style={styles.close}
              >
                ×
              </button>
            </div>

            <div style={styles.imageBody}>
              <img
                src={`/api/shift-history/${imagePlan.id}/image`}
                alt={`Originalfoto ${imagePlan.originalName}`}
                style={styles.image}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

const styles = {
  overlay: {
    position: 'absolute',
    zIndex: 20,
    inset: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--bg2)'
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '15px 16px',
    borderBottom: '1px solid var(--border)'
  },
  title: {
    margin: 0,
    color: 'var(--text)',
    fontSize: 17
  },
  subtitle: {
    marginTop: 4,
    color: 'var(--text3)',
    fontSize: 11,
    lineHeight: 1.45
  },
  close: {
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: 8,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 21,
    lineHeight: 1
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    padding: '10px 16px',
    borderBottom: '1px solid var(--border)'
  },
  tabs: {
    display: 'flex',
    gap: 6
  },
  tab: {
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg3)',
    color: 'var(--text3)',
    fontSize: 11
  },
  activeTab: {
    borderColor: 'var(--accent)',
    color: 'var(--text)'
  },
  subtleButton: {
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--text3)',
    fontSize: 10
  },
  body: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    padding: 14,
    boxSizing: 'border-box'
  },
  list: {
    display: 'grid',
    gap: 10
  },
  card: {
    minWidth: 0,
    padding: 12,
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--bg3)'
  },
  cardTop: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10
  },
  cardText: {
    minWidth: 0,
    overflowWrap: 'anywhere'
  },
  planName: {
    color: 'var(--text)',
    fontSize: 13
  },
  meta: {
    color: 'var(--text3)',
    fontSize: 10,
    lineHeight: 1.45
  },
  idBadge: {
    flexShrink: 0,
    color: 'var(--text3)',
    fontSize: 9,
    fontFamily: 'var(--font-mono)'
  },
  stats: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 9,
    marginTop: 9,
    color: 'var(--text2)',
    fontSize: 10,
    fontFamily: 'var(--font-mono)'
  },
  latestSync: {
    display: 'grid',
    gap: 3,
    marginTop: 9,
    padding: 9,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg2)',
    color: 'var(--text2)',
    fontSize: 10
  },
  summaryLine: {
    color: 'var(--text3)',
    fontSize: 10,
    lineHeight: 1.45
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 10
  },
  primaryButton: {
    padding: '8px 10px',
    borderRadius: 8,
    background: 'var(--accent)',
    color: '#0d0d0d',
    fontSize: 10,
    fontWeight: 700
  },
  secondaryButton: {
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg2)',
    color: 'var(--text2)',
    fontSize: 10
  },
  deleteButton: {
    padding: '8px 10px',
    border: '1px solid rgba(255,80,80,0.32)',
    borderRadius: 8,
    background: 'rgba(255,80,80,0.07)',
    color: 'var(--danger)',
    fontSize: 10
  },
  runList: {
    display: 'grid',
    gap: 7,
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid var(--border)'
  },
  runCard: {
    padding: 9,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg2)',
    color: 'var(--text2)',
    fontSize: 10
  },
  runTop: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 6
  },
  runError: {
    marginTop: 4,
    color: 'var(--danger)',
    fontSize: 10
  },
  empty: {
    padding: 34,
    textAlign: 'center',
    color: 'var(--text3)',
    fontSize: 12
  },
  success: {
    marginBottom: 10,
    padding: 10,
    border: '1px solid var(--green-dim)',
    borderRadius: 9,
    background: 'var(--green-bg)',
    color: 'var(--green)',
    fontSize: 11
  },
  error: {
    marginBottom: 10,
    padding: 10,
    border: '1px solid rgba(255,80,80,0.3)',
    borderRadius: 9,
    background: 'rgba(255,80,80,0.08)',
    color: 'var(--danger)',
    fontSize: 11
  },
  imageBackdrop: {
    position: 'absolute',
    zIndex: 30,
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    boxSizing: 'border-box',
    background: 'rgba(0,0,0,0.82)'
  },
  imageModal: {
    width: '100%',
    maxWidth: 980,
    maxHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    border: '1px solid var(--border)',
    borderRadius: 12,
    background: 'var(--bg2)'
  },
  imageHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '10px 12px',
    color: 'var(--text)',
    fontSize: 11,
    overflowWrap: 'anywhere'
  },
  imageBody: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 8,
    background: '#111'
  },
  image: {
    display: 'block',
    width: '100%',
    height: 'auto',
    objectFit: 'contain'
  }
}
