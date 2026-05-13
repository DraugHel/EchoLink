import { useState, useEffect, useRef, useCallback } from 'react'
import Sidebar from '../components/Sidebar.jsx'
import Message from '../components/Message.jsx'
import SettingsPanel from '../components/SettingsPanel.jsx'
import api from '../lib/api.js'

export default function Chat({ user, onLogout }) {
  const [conversations, setConversations] = useState([])
  const [activeConvo, setActiveConvo] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)
  const abortRef = useRef(null)

  useEffect(() => {
    loadConversations()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function loadConversations() {
    const convos = await api.get('/api/conversations')
    setConversations(convos)
  }

  async function selectConvo(convo) {
    setActiveConvo(convo)
    setLoading(true)
    try {
      const msgs = await api.get(`/api/conversations/${convo.id}/messages`)
      setMessages(msgs)
    } finally {
      setLoading(false)
    }
  }

  async function createConvo() {
    const convo = await api.post('/api/conversations', {})
    setConversations(prev => [convo, ...prev])
    await selectConvo(convo)
  }

  async function deleteConvo(id) {
    await api.delete(`/api/conversations/${id}`)
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeConvo?.id === id) {
      setActiveConvo(null)
      setMessages([])
    }
  }

  async function renameConvo(id, title) {
    const updated = await api.patch(`/api/conversations/${id}`, { title })
    setConversations(prev => prev.map(c => c.id === id ? updated : c))
    if (activeConvo?.id === id) setActiveConvo(updated)
  }

  function updateConvo(updated) {
    setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
    setActiveConvo(updated)
  }

  async function sendMessage() {
    if (!input.trim() || streaming || !activeConvo) return
    const content = input.trim()
    setInput('')
    textareaRef.current?.focus()

    // Optimistic user message
    setMessages(prev => [...prev, { id: Date.now(), role: 'user', content }])
    setStreaming(true)

    let assistantContent = ''
    const assistantId = Date.now() + 1
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', streaming: true }])

    try {
      const response = await fetch(`/api/chat/${activeConvo.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      })

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '))
        for (const line of lines) {
          try {
            const json = JSON.parse(line.slice(6))
            if (json.token) {
              assistantContent += json.token
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: assistantContent } : m
              ))
            }
            if (json.done) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, streaming: false } : m
              ))
              // Refresh convo list (title may have changed)
              loadConversations()
            }
            if (json.error) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: `Error: ${json.error}`, streaming: false } : m
              ))
            }
          } catch {}
        }
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: `Connection error: ${err.message}`, streaming: false } : m
      ))
    } finally {
      setStreaming(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function autoResize(e) {
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  const mobile = window.innerWidth < 768

  return (
    <div style={styles.root}>
      {/* Sidebar: fixed overlay on mobile, in-flow on desktop */}
      {(!mobile || mobileSidebar) && (
        <Sidebar
          conversations={conversations}
          activeId={activeConvo?.id}
          onSelect={selectConvo}
          onCreate={createConvo}
          onDelete={deleteConvo}
          onRename={renameConvo}
          user={user}
          onLogout={onLogout}
          mobileOpen={mobileSidebar}
          onMobileClose={() => setMobileSidebar(false)}
        />
      )}
      {mobile && !mobileSidebar && null}

      {/* Main area */}
      <main style={styles.main}>
        {/* Topbar */}
        <div style={styles.topbar}>
          <button style={styles.menuBtn} onClick={() => setMobileSidebar(v => !v)}>
            <MenuIcon />
          </button>
          <span style={styles.convoTitle}>
            {activeConvo ? activeConvo.title : 'EchoLink'}
          </span>
          {activeConvo && (
            <button style={styles.settingsBtn} onClick={() => setShowSettings(true)} title="Settings">
              <GearIcon />
            </button>
          )}
        </div>

        {/* Messages */}
        <div style={styles.messages}>
          {!activeConvo && (
            <div style={styles.empty} className="fade-in">
              <div style={styles.emptyLogo}>
                <svg width="48" height="48" viewBox="0 0 32 32" fill="none">
                  <rect width="32" height="32" rx="8" fill="#2ecc71"/>
                  <path d="M8 22 L14 10 L20 18 L24 14" stroke="#0d0d0d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="24" cy="14" r="2" fill="#0d0d0d"/>
                </svg>
              </div>
              <h2 style={styles.emptyTitle}>Echo<span style={{ color:'var(--green)' }}>Link</span></h2>
              <p style={styles.emptySub}>Select a conversation or create a new one.</p>
              <button style={styles.emptyBtn} onClick={createConvo}>+ New Conversation</button>
            </div>
          )}

          {activeConvo && loading && (
            <div style={{ display:'flex', justifyContent:'center', paddingTop: 40 }}>
              <div style={{ width:20, height:20, border:'2px solid var(--green)', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
            </div>
          )}

          {activeConvo && !loading && messages.map(m => (
            <Message key={m.id} role={m.role} content={m.content} streaming={m.streaming} />
          ))}

          {activeConvo && !loading && messages.length === 0 && (
            <div style={styles.emptyChat}>
              <p>Start the conversation below.</p>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        {activeConvo && (
          <div style={styles.inputWrap}>
            <div style={styles.inputRow}>
              <textarea
                ref={textareaRef}
                style={styles.textarea}
                value={input}
                onChange={e => { setInput(e.target.value); autoResize(e) }}
                onKeyDown={handleKeyDown}
                placeholder="Type your message…"
                rows={1}
                disabled={streaming}
              />
              <button
                style={{ ...styles.sendBtn, opacity: (!input.trim() || streaming) ? 0.4 : 1 }}
                onClick={sendMessage}
                disabled={!input.trim() || streaming}
              >
                {streaming ? <StopIcon /> : <SendIcon />}
              </button>
            </div>
            <p style={styles.hint}>Enter to send · Shift+Enter for newline</p>
          </div>
        )}
      </main>

      {showSettings && activeConvo && (
        <SettingsPanel
          conversation={activeConvo}
          onUpdate={updateConvo}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

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

const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
)

const StopIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
  </svg>
)

const styles = {
  root: { display: 'flex', height: '100%', overflow: 'hidden' },
  sidebarWrap: { display: 'flex', flexShrink: 0 },
  sidebarHidden: {},
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 },
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
  messages: {
    flex: 1, overflowY: 'auto',
    padding: '24px 20px',
    display: 'flex', flexDirection: 'column'
  },
  empty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', textAlign: 'center',
    gap: 14, paddingBottom: 60
  },
  emptyLogo: { marginBottom: 4 },
  emptyTitle: { fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 700 },
  emptySub: { color: 'var(--text2)', fontSize: 15 },
  emptyBtn: {
    marginTop: 8, padding: '12px 24px', borderRadius: 10,
    background: 'var(--green)', color: '#0d0d0d', fontWeight: 600,
    fontSize: 15, cursor: 'pointer', border: 'none', fontFamily: 'var(--font-sans)'
  },
  emptyChat: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 14 },
  inputWrap: {
    padding: '12px 16px 10px', borderTop: '1px solid var(--border)',
    background: 'var(--bg2)', flexShrink: 0
  },
  inputRow: { display: 'flex', gap: 10, alignItems: 'flex-end' },
  textarea: {
    flex: 1, padding: '12px 14px', resize: 'none',
    borderRadius: 12, lineHeight: 1.5, fontSize: 15,
    maxHeight: 160, overflowY: 'auto',
    border: '1px solid var(--border)',
    transition: 'border-color var(--transition)'
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
    background: 'var(--green)', color: '#0d0d0d',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', cursor: 'pointer', transition: 'opacity var(--transition)'
  },
  hint: { fontSize: 11, color: 'var(--text3)', marginTop: 6, textAlign: 'center' }
}
