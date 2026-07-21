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
  mobile = false,
  onCancel,
  onResume,
  onDismiss
}) {
  const [expanded, setExpanded] = useState(!mobile)

  useEffect(() => {
    setExpanded(!mobile)
  }, [run?.id, mobile])

  if (!run) return null

  const active = run.status === 'running'

  return (
    <section
      aria-label="Arbeitsablauf des aktuellen Chat-Auftrags"
      style={{
        width: mobile
          ? 'calc(100% - 20px)'
          : 'min(760px, calc(100% - 32px))',
        maxWidth: 760,
        flexShrink: 0,
        alignSelf: 'center',
        marginTop: 6,
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
        <div
          style={{
            maxHeight: mobile ? '46dvh' : '52vh',
            padding: '0 8px 8px',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            WebkitOverflowScrolling: 'touch'
          }}
        >
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

      {run.status === 'cancelled' && run.checkpoints?.length > 0 && (
        <div style={{ padding: '0 11px 10px' }}>
          <button
            type="button"
            onClick={() => onResume?.(run.checkpoints)}
            style={{
              width: '100%',
              minHeight: 34,
              border: '1px solid var(--accent)',
              borderRadius: 8,
              background: 'transparent',
              color: 'var(--accent)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11
            }}
          >
            Fortsetzen ab {run.checkpoints.length} Checkpoint{run.checkpoints.length === 1 ? '' : 's'}
          </button>
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
