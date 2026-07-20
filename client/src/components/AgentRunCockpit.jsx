function formatUnix(value, timezone) {
  if (!value) return '–'

  try {
    return new Date(Number(value) * 1000)
      .toLocaleString('de-AT', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: timezone || undefined
      })
  } catch {
    return new Date(Number(value) * 1000)
      .toLocaleString('de-AT')
  }
}

function phaseLabel(phase, controlState) {
  if (controlState === 'cancel_requested') {
    return 'Abbruch angefordert'
  }

  const labels = {
    queued: 'Wartet',
    planning: 'Plant',
    running: 'Läuft',
    finalizing: 'Schließt ab',
    success: 'Erfolgreich',
    failed: 'Fehlgeschlagen',
    cancelled: 'Abgebrochen',
    interrupted: 'Unterbrochen'
  }

  return labels[phase] || phase || 'Unbekannt'
}

function phaseColor(phase, controlState) {
  if (
    controlState === 'cancel_requested' ||
    phase === 'failed' ||
    phase === 'cancelled' ||
    phase === 'interrupted'
  ) {
    return 'var(--danger)'
  }

  if (phase === 'success') return 'var(--accent)'
  return 'var(--text2)'
}

function eventSymbol(type) {
  if (type === 'completed') return '✓'
  if (type === 'failed') return '!'
  if (type === 'cancelled') return '×'
  if (type === 'cancel_requested') return '◼'
  if (type === 'tool_started') return '›'
  if (type === 'tool_finished') return '·'
  if (type === 'plan') return '≡'
  if (type === 'quality') return '◇'
  return '•'
}

function smallButton({ danger = false, disabled = false } = {}) {
  return {
    minHeight: 34,
    padding: '7px 10px',
    border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
    borderRadius: 8,
    background: 'var(--bg3)',
    color: danger ? 'var(--danger)' : 'var(--text2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1
  }
}

export default function AgentRunCockpit({
  run,
  timezone,
  loading,
  cancelling,
  onRefresh,
  onCancel
}) {
  if (loading && !run) {
    return (
      <div style={{ color: 'var(--text3)', fontSize: 12 }}>
        Run-Cockpit wird geladen …
      </div>
    )
  }

  if (!run) return null

  const plan = Array.isArray(run.plan) ? run.plan : []
  const active = run.status === 'running'
  const cancelRequested =
    run.controlState === 'cancel_requested'
  const finished = ['success', 'failed', 'cancelled', 'interrupted']
    .includes(run.phase)

  return (
    <section
      aria-label="Agent Run Cockpit"
      style={{
        marginTop: 8,
        padding: 10,
        border: '1px solid var(--border2)',
        borderRadius: 10,
        background: 'var(--bg2)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          flexWrap: 'wrap'
        }}
      >
        <div style={{ flex: 1, minWidth: 180 }}>
          <div
            style={{
              color: phaseColor(run.phase, run.controlState),
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              fontWeight: 700
            }}
          >
            {phaseLabel(run.phase, run.controlState)}
          </div>

          <div
            style={{
              marginTop: 4,
              color: 'var(--text1)',
              fontSize: 12,
              lineHeight: 1.45,
              overflowWrap: 'anywhere'
            }}
          >
            {run.progress || 'Noch kein Fortschritt gemeldet.'}
          </div>

          <div
            style={{
              marginTop: 4,
              color: 'var(--text3)',
              fontSize: 10,
              lineHeight: 1.4
            }}
          >
            Start: {formatUnix(run.startedAt, timezone)}
            {run.finishedAt
              ? ` · Ende: ${formatUnix(run.finishedAt, timezone)}`
              : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            style={smallButton({ disabled: loading })}
          >
            Aktualisieren
          </button>

          {active && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling || cancelRequested}
              style={smallButton({
                danger: true,
                disabled: cancelling || cancelRequested
              })}
            >
              {cancelRequested
                ? 'Abbruch angefordert'
                : cancelling
                  ? 'Fordere Abbruch an …'
                  : 'Run abbrechen'}
            </button>
          )}
        </div>
      </div>

      {plan.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              marginBottom: 6,
              color: 'var(--text3)',
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: '0.06em',
              textTransform: 'uppercase'
            }}
          >
            Plan
          </div>

          <div style={{ display: 'grid', gap: 5 }}>
            {plan.map((step, index) => {
              const complete =
                run.phase === 'success' ||
                index < run.currentStep
              const current =
                !finished && index === run.currentStep
              const failedCurrent =
                finished &&
                run.phase !== 'success' &&
                index === run.currentStep

              return (
                <div
                  key={step.id || `${index}-${step.title}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '22px minmax(0, 1fr)',
                    gap: 7,
                    alignItems: 'start',
                    padding: '6px 7px',
                    borderRadius: 8,
                    background: current
                      ? 'var(--bg4)'
                      : 'var(--bg3)',
                    color: failedCurrent
                      ? 'var(--danger)'
                      : complete
                        ? 'var(--accent)'
                        : current
                          ? 'var(--text1)'
                          : 'var(--text3)',
                    fontSize: 11,
                    lineHeight: 1.4
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 20,
                      height: 20,
                      display: 'grid',
                      placeItems: 'center',
                      border: '1px solid currentColor',
                      borderRadius: 999,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9
                    }}
                  >
                    {complete ? '✓' : failedCurrent ? '!' : index + 1}
                  </span>
                  <span style={{ overflowWrap: 'anywhere' }}>
                    {step.title}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div
          style={{
            marginBottom: 6,
            color: 'var(--text3)',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.06em',
            textTransform: 'uppercase'
          }}
        >
          Timeline
        </div>

        {run.events?.length ? (
          <div style={{ display: 'grid', gap: 5 }}>
            {run.events.map(event => (
              <div
                key={event.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '20px minmax(0, 1fr)',
                  gap: 7,
                  alignItems: 'start',
                  color: ['failed', 'cancelled', 'cancel_requested']
                    .includes(event.type)
                    ? 'var(--danger)'
                    : 'var(--text2)',
                  fontSize: 11,
                  lineHeight: 1.4
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    color: 'currentColor',
                    fontFamily: 'var(--font-mono)',
                    textAlign: 'center'
                  }}
                >
                  {eventSymbol(event.type)}
                </span>

                <div style={{ minWidth: 0 }}>
                  <div style={{ overflowWrap: 'anywhere' }}>
                    {event.message || event.type}
                  </div>
                  {event.detail && (
                    <div
                      style={{
                        marginTop: 2,
                        color: 'var(--text3)',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere'
                      }}
                    >
                      {event.detail}
                    </div>
                  )}
                  <div
                    style={{
                      marginTop: 2,
                      color: 'var(--text3)',
                      fontSize: 9
                    }}
                  >
                    {formatUnix(event.createdAt, timezone)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--text3)', fontSize: 11 }}>
            Noch keine Ereignisse vorhanden.
          </div>
        )}
      </div>

      {run.error && (
        <div
          style={{
            marginTop: 10,
            padding: '8px 9px',
            border: '1px solid var(--danger)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 11,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {run.error}
        </div>
      )}

      {run.result && finished && (
        <details
          style={{
            marginTop: 10,
            borderRadius: 8,
            background: 'var(--bg3)'
          }}
        >
          <summary
            style={{
              padding: '7px 9px',
              color: 'var(--text3)',
              fontSize: 11,
              cursor: 'pointer'
            }}
          >
            Ergebnis anzeigen
          </summary>
          <div
            style={{
              padding: '0 9px 9px',
              color: 'var(--text2)',
              fontSize: 11,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere'
            }}
          >
            {run.result}
          </div>
        </details>
      )}
    </section>
  )
}
