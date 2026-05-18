import ThemePicker from '../components/ThemePicker.jsx'

const BoltIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4, verticalAlign: -2 }}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
)
const MenuIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
  </svg>
)
const GearIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
)

export default function ChatHeader({ activeConvo, agentEnabled, agentMode, onToggleAgent, onOpenMenu, onOpenSettings }) {
  return (
    <div style={styles.topbar}>
      <button style={styles.menuBtn} onClick={onOpenMenu}>
        <MenuIcon />
      </button>
      <span style={styles.convoTitle}>
        {activeConvo ? activeConvo.title : 'EchoLink'}
      </span>
      {agentEnabled && (
        <button
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "6px 10px", borderRadius: 8,
            border: "1px solid " + (agentMode ? "var(--accent)" : "var(--border)"),
            background: agentMode ? "var(--accent)" : "transparent",
            color: agentMode ? "var(--user-text, #0d0d0d)" : "var(--text2)",
            fontSize: 12, fontWeight: 600, cursor: "pointer",
            fontFamily: "var(--font-mono)", transition: "all var(--transition)"
          }}
          onClick={onToggleAgent}
          title={agentMode ? "Agent mode ON" : "Agent mode OFF"}
        >
          <BoltIcon /> Agent
        </button>
      )}
      <ThemePicker />
      {activeConvo && (
        <button style={styles.settingsBtn} onClick={onOpenSettings} title="Settings">
          <GearIcon />
        </button>
      )}
    </div>
  )
}

const styles = {
  topbar: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '0 16px', height: 54, flexShrink: 0,
    borderBottom: '1px solid var(--border)', background: 'var(--bg2)'
  },
  menuBtn: { color: 'var(--text2)', display: 'flex', alignItems: 'center', flexShrink: 0 },
  convoTitle: {
    flex: 1, fontSize: 14, fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)'
  },
  settingsBtn: { color: 'var(--text2)', display: 'flex', alignItems: 'center', flexShrink: 0 },
}