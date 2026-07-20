import { useEffect, useState } from 'react'
import AgentRunCockpit from './AgentRunCockpit.jsx'

function statusText(run) {
  if (run?.controlState === 'cancel_requested') {
    return 'Abbruch angefordert'
  }

  const labels = {
    planning: 'Plant',
    running: 'Läuft',
    waiting_approval: 'Wartet auf Freigabe',
    finalizing: 'Prüft Abschluss',
    success: 'Erledigt',
    cancelled: 'Abgebrochen',
    failed: 'Fehlgeschlagen'
  }

  return labels[run?.phase] || 'Ablauf'
}

export default function ChatAgentCockpit({
  run,
  streaming,
  onCancel,
  onDismiss
}) {
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    setExpanded(true)
  }, [run?.id])

  if (!run) return null

  const active = run.status === 'running'

  return (
    <section
      aria-label="Arbeitsablauf des aktuellen Chat-Auftrags"
      style={{
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
        marginTop: 10,
        marginBottom: 4,
        border: '1px solid var(--border2)',
        borderRadius: 11,
        background: 'var(--bg2)',
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          minHeight: 42,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 8px 7px 11px'
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          style={{
            minWidth: 0,
            flex: 1,
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) auto',
            alignItems: 'center',
            gap: 8,
            padding: 0,
            background: 'transparent',
            color: 'var(--text2)',
            textAlign: 'left'
          }}
        >
          <span
            aria-hidden="true"
            style={{
              color: active ? 'var(--accent)' : 'var(--text3)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12
            }}
          >
            {active ? '●' : run.phase === 'success' ? '✓' : '•'}
          </span>

          <span style={{ minWidth: 0 }}>
            <strong
              style={{
                display: 'block',
                color: 'var(--text1)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11
              }}
            >
              Chat-Ablauf · {statusText(run)}
            </strong>
            <span
              style={{
                display: 'block',
                marginTop: 2,
                overflow: 'hidden',
                color: 'var(--text3)',
                fontSize: 10,
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {run.progress}
            </span>
          </span>

          <span
            aria-hidden="true"
            style={{
              color: 'var(--text3)',
              fontSize: 14
            }}
          >
            {expanded ? '⌃' : '⌄'}
          </span>
        </button>

        {!active && (
          <button
            type="button"
            onClick={onDismiss}
            title="Ablauf ausblenden"
            aria-label="Ablauf ausblenden"
            style={{
              width: 30,
              height: 30,
              flex: '0 0 auto',
              display: 'grid',
              placeItems: 'center',
              padding: 0,
              borderRadius: 8,
              background: 'transparent',
              color: 'var(--text3)',
              fontSize: 18
            }}
          >
            ×
          </button>
        )}
      </div>

      {expanded && (
        <div style={{ padding: '0 8px 8px' }}>
          <AgentRunCockpit
            run={run}
            loading={false}
            cancelling={run.controlState === 'cancel_requested'}
            showRefresh={false}
            cancelLabel="Antwort stoppen"
            embedded
            onCancel={onCancel}
          />
        </div>
      )}

      {active && !streaming && run.phase === 'waiting_approval' && (
        <div
          style={{
            padding: '0 11px 9px',
            color: 'var(--text3)',
            fontSize: 10,
            lineHeight: 1.4
          }}
        >
          Die Freigabe erfolgt direkt an der betreffenden Chat-Nachricht.
        </div>
      )}
    </section>
  )
}
