import PushButton from './PushButton.jsx'
import ThemePicker from './ThemePicker.jsx'

function ToolIcon({ type }) {
  const common = {
    width: 21,
    height: 21,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  }

  if (type === 'shift') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M8 2v4M16 2v4M3 9h18" />
        <path d="M12 13v5M9.5 15.5 12 18l2.5-2.5" />
      </svg>
    )
  }

  if (type === 'tasks') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5v5l3.5 2" />
      </svg>
    )
  }

  if (type === 'memory') {
    return (
      <svg {...common}>
        <path d="M9.5 4.5a3 3 0 0 0-5 2.2 3.2 3.2 0 0 0 .8 2.1A3.5 3.5 0 0 0 7 15.2V18a2 2 0 0 0 2 2h1V4.8a3 3 0 0 0-.5-.3Z" />
        <path d="M14.5 4.5a3 3 0 0 1 5 2.2 3.2 3.2 0 0 1-.8 2.1 3.5 3.5 0 0 1-1.7 6.4V18a2 2 0 0 1-2 2h-1V4.8a3 3 0 0 1 .5-.3Z" />
        <path d="M7 9h3M14 9h3M7 14h3M14 14h3" />
      </svg>
    )
  }

  if (type === 'system') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 14 2.5-3 2.5 2 3-5 2 3" />
      </svg>
    )
  }

  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  )
}

function ToolButton({
  icon,
  title,
  description,
  onClick,
  disabled = false
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles.tool,
        opacity: disabled ? 0.42 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer'
      }}
    >
      <span style={styles.toolIcon}>
        <ToolIcon type={icon} />
      </span>

      <span style={styles.toolText}>
        <strong style={styles.toolTitle}>
          {title}
        </strong>

        <span style={styles.toolDescription}>
          {description}
        </span>
      </span>
    </button>
  )
}

export default function AppToolsMenu({
  activeConversation,
  systemProblem,
  onOpenShift,
  onOpenTasks,
  onOpenMemory,
  onOpenSystem,
  onOpenSettings,
  onClose
}) {
  return (
    <div
      className="echolink-tools-overlay"
      onClick={onClose}
      style={styles.overlay}
    >
      <section
        className="echolink-tools-panel"
        onClick={event => event.stopPropagation()}
        style={styles.panel}
      >
        <header style={styles.header}>
          <div style={styles.headerText}>
            <strong style={styles.title}>
              EchoLink
            </strong>

            <span style={styles.subtitle}>
              Werkzeuge und Einstellungen
            </span>
          </div>

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
          <div style={styles.sectionLabel}>
            Bereiche
          </div>

          <div style={styles.grid}>
            <ToolButton
              icon="shift"
              title="Schichtplan"
              description="Importieren, prüfen und synchronisieren"
              onClick={onOpenShift}
            />

            <ToolButton
              icon="tasks"
              title="Aufgaben"
              description="Agenten, Erinnerungen und Zeitpläne"
              onClick={onOpenTasks}
            />

            <ToolButton
              icon="memory"
              title="Memory"
              description={
                activeConversation
                  ? 'Erinnerungen dieser Unterhaltung'
                  : 'Zuerst eine Unterhaltung öffnen'
              }
              onClick={onOpenMemory}
              disabled={!activeConversation}
            />

            <ToolButton
              icon="system"
              title="Systemstatus"
              description={
                systemProblem
                  ? 'Mindestens eine Prüfung braucht Aufmerksamkeit'
                  : 'Prozesse, Ressourcen und Backups'
              }
              onClick={onOpenSystem}
            />

            <ToolButton
              icon="settings"
              title="Chat-Einstellungen"
              description={
                activeConversation
                  ? 'Modell, Prompt und Antwortverhalten'
                  : 'Zuerst eine Unterhaltung öffnen'
              }
              onClick={onOpenSettings}
              disabled={!activeConversation}
            />
          </div>

          <div style={styles.sectionLabel}>
            Schnellzugriff
          </div>

          <div style={styles.quickGrid}>
            <div style={styles.quickCard}>
              <div>
                <strong style={styles.quickTitle}>
                  Benachrichtigungen
                </strong>
                <div style={styles.quickDescription}>
                  Push-Mitteilungen verwalten
                </div>
              </div>

              <PushButton style={styles.quickControl} />
            </div>

            <div style={styles.quickCard}>
              <div>
                <strong style={styles.quickTitle}>
                  Darstellung
                </strong>
                <div style={styles.quickDescription}>
                  Farbe und Theme wechseln
                </div>
              </div>

              <ThemePicker />
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 180,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    paddingTop: 'env(safe-area-inset-top)',
    background: 'rgba(0,0,0,0.62)',
    backdropFilter: 'blur(4px)'
  },
  panel: {
    width: 420,
    maxWidth: '100vw',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    borderLeft: '1px solid var(--border)',
    background: 'var(--bg2)',
    boxShadow: '-18px 0 60px rgba(0,0,0,0.45)'
  },
  header: {
    minHeight: 74,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '15px 18px',
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
    fontSize: 12
  },
  close: {
    width: 42,
    height: 42,
    flexShrink: 0,
    border: '1px solid var(--border)',
    borderRadius: 12,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 23
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding:
      '18px 18px calc(22px + env(safe-area-inset-bottom))'
  },
  sectionLabel: {
    margin: '2px 2px 9px',
    color: 'var(--text3)',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em'
  },
  grid: {
    display: 'grid',
    gap: 9,
    marginBottom: 24
  },
  tool: {
    width: '100%',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: 13,
    border: '1px solid var(--border)',
    borderRadius: 12,
    background: 'var(--bg3)',
    color: 'var(--text1)',
    textAlign: 'left'
  },
  toolIcon: {
    width: 42,
    height: 42,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 11,
    background: 'var(--accent-bg)',
    color: 'var(--accent)'
  },
  toolText: {
    minWidth: 0,
    display: 'grid',
    gap: 3
  },
  toolTitle: {
    fontSize: 14,
    lineHeight: 1.25
  },
  toolDescription: {
    color: 'var(--text3)',
    fontSize: 11,
    lineHeight: 1.35
  },
  quickGrid: {
    display: 'grid',
    gap: 9
  },
  quickCard: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: 13,
    border: '1px solid var(--border)',
    borderRadius: 12,
    background: 'var(--bg3)'
  },
  quickTitle: {
    color: 'var(--text1)',
    fontSize: 13
  },
  quickDescription: {
    marginTop: 3,
    color: 'var(--text3)',
    fontSize: 10
  },
  quickControl: {
    flexShrink: 0
  }
}
