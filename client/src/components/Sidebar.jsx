import { useState } from 'react'
import api from '../lib/api.js'

export default function Sidebar({ conversations, activeId, onSelect, onCreate, onDelete, onRename, user, onLogout, mobileOpen, onMobileClose }) {
  const [editingId, setEditingId] = useState(null)
  const [editTitle, setEditTitle] = useState('')
  const [hoverId, setHoverId] = useState(null)

  function startEdit(e, c) {
    e.stopPropagation()
    setEditingId(c.id)
    setEditTitle(c.title)
  }

  async function commitEdit(c) {
    if (editTitle.trim() && editTitle !== c.title) {
      await onRename(c.id, editTitle.trim())
    }
    setEditingId(null)
  }

  async function handleLogout() {
    await api.post('/api/auth/logout', {})
    onLogout()
  }

  return (
    <>
      {/* Overlay for mobile */}
      {mobileOpen && (
        <div
          onClick={onMobileClose}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 98,
          }}
        />
      )}

      <aside style={{
        // On mobile: fixed overlay, slide in/out
        // On desktop: normal sidebar in flow
        position: window.innerWidth < 768 ? 'fixed' : 'relative',
        top: 0, left: 0, height: '100%',
        width: 'var(--sidebar-w)',
        background: 'var(--bg2)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 99,
        transform: window.innerWidth < 768
          ? (mobileOpen ? 'translateX(0)' : 'translateX(-100%)')
          : 'none',
        transition: 'transform 0.25s ease',
        flexShrink: 0,
      }}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.logo}>
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#2ecc71"/>
              <path d="M8 22 L14 10 L20 18 L24 14" stroke="#0d0d0d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="24" cy="14" r="2" fill="#0d0d0d"/>
            </svg>
            <span style={styles.logoText}>Echo<span style={{ color:'var(--green)' }}>Link</span></span>
          </div>
          <button style={styles.newBtn} onClick={onCreate} title="New conversation">
            <PlusIcon />
          </button>
        </div>

        {/* Conversations */}
        <div style={styles.list}>
          {conversations.length === 0 && (
            <p style={styles.empty}>No conversations yet.<br/>Click + to start one.</p>
          )}
          {conversations.map(c => (
            <div
              key={c.id}
              style={{
                ...styles.item,
                ...(c.id === activeId ? styles.itemActive : {}),
                ...(hoverId === c.id && c.id !== activeId ? styles.itemHover : {})
              }}
              onClick={() => { onSelect(c); onMobileClose?.() }}
              onMouseEnter={() => setHoverId(c.id)}
              onMouseLeave={() => setHoverId(null)}
            >
              {editingId === c.id ? (
                <input
                  style={styles.editInput}
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onBlur={() => commitEdit(c)}
                  onKeyDown={e => { if (e.key === 'Enter') commitEdit(c); if (e.key === 'Escape') setEditingId(null) }}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <>
                  <span style={styles.itemTitle}>{c.title}</span>
                  <div style={{ ...styles.itemActions, opacity: hoverId === c.id || c.id === activeId ? 1 : 0 }}>
                    <button style={styles.iconBtn} onClick={e => startEdit(e, c)} title="Rename">
                      <PencilIcon />
                    </button>
                    <button style={{ ...styles.iconBtn, color: 'var(--danger)' }} onClick={e => { e.stopPropagation(); onDelete(c.id) }} title="Delete">
                      <TrashIcon />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <span style={styles.username}>{user.username}</span>
          <button style={styles.logoutBtn} onClick={handleLogout} title="Sign out">
            <LogoutIcon />
          </button>
        </div>
      </aside>
    </>
  )
}

const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14"/>
  </svg>
)
const PencilIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
)
const TrashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
)
const LogoutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
)

const styles = {
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 14px', borderBottom: '1px solid var(--border)'
  },
  logo: { display: 'flex', alignItems: 'center', gap: 8 },
  logoText: { fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700 },
  newBtn: {
    width: 30, height: 30, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--green)', border: '1px solid var(--border)',
    background: 'var(--bg3)'
  },
  list: { flex: 1, overflowY: 'auto', padding: '8px' },
  empty: { color: 'var(--text3)', fontSize: 13, padding: '20px 8px', lineHeight: 1.6 },
  item: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '9px 10px', borderRadius: 8, cursor: 'pointer',
    marginBottom: 2, minHeight: 38, gap: 6,
    transition: 'background var(--transition)', border: '1px solid transparent'
  },
  itemActive: { background: 'var(--green-bg)', border: '1px solid var(--green-dim)' },
  itemHover: { background: 'var(--bg3)' },
  itemTitle: {
    fontSize: 13, color: 'var(--text)', flex: 1,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  },
  itemActions: { display: 'flex', gap: 4, transition: 'opacity var(--transition)', flexShrink: 0 },
  iconBtn: {
    width: 24, height: 24, borderRadius: 5, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    color: 'var(--text2)', background: 'transparent'
  },
  editInput: {
    flex: 1, padding: '2px 6px', fontSize: 13,
    background: 'var(--bg3)', border: '1px solid var(--green)',
    borderRadius: 6, color: 'var(--text)'
  },
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px', borderTop: '1px solid var(--border)'
  },
  username: { fontSize: 13, color: 'var(--text2)', fontFamily: 'var(--font-mono)' },
  logoutBtn: { color: 'var(--text3)', display: 'flex', alignItems: 'center' }
}
