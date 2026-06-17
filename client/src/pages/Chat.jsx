import { useState, useEffect, useRef, useCallback } from 'react'
import Sidebar from '../components/Sidebar.jsx'
import Message from '../components/Message.jsx'
import MessageInput from '../components/MessageInput.jsx'
import SettingsPanel from '../components/SettingsPanel.jsx'
import api from '../lib/api.js'
import ThemePicker, { useTheme } from '../components/ThemePicker.jsx'

function useIsMobile() {
  const [mobile, setMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return mobile
}

export default function Chat({ user, onLogout }) {
  const [conversations, setConversations] = useState([])
  const [activeConvo, setActiveConvo] = useState(null)
  const [messages, setMessages] = useState([])
  const [streaming, setStreaming] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const [availableModels, setAvailableModels] = useState([])
  const [agentMode, setAgentMode] = useState(true)
  const [agentEnabled, setAgentEnabled] = useState(false)
  const [attachments, setAttachments] = useState([])  // array of {filename, originalName, size, kind}
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)
  const [loading, setLoading] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const messagesEndRef = useRef(null)
  const messagesContainerRef = useRef(null)
  const inputRef = useRef(null)
  const abortControllerRef = useRef(null)
  const mobile = useIsMobile()
  useTheme()

  // Swipe to open/close sidebar
  const swipeStartX = useRef(null)
  useEffect(() => {
    const onTouchStart = e => { swipeStartX.current = e.touches[0].clientX }
    const onTouchEnd = e => {
      if (swipeStartX.current === null) return
      const dx = e.changedTouches[0].clientX - swipeStartX.current
      if (dx > 50 && swipeStartX.current < 200) setMobileSidebar(true)
      if (dx < -60 && mobileSidebar) setMobileSidebar(false)
      swipeStartX.current = null
    }
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [mobileSidebar])

  useEffect(() => {
    api.get("/api/hermes/access").then(d => setAgentEnabled(d.enabled)).catch(() => {})
    loadConversations().then(convos => {
      if (convos && convos.length > 0) selectConvo(convos[0])
    })
    api.get('/api/chat/models/list')
      .then(m => setAvailableModels(m.map(x => x.name)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Scroll-to-bottom button: show when scrolled up >200px from bottom
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollBtn(distFromBottom > 200)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll() // initial check
    return () => el.removeEventListener('scroll', onScroll)
  }, [activeConvo])

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  async function loadConversations() {
    const convos = await api.get('/api/conversations')
    setConversations(convos)
    return convos
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
    if (activeConvo && !agentMode) {
      try { await api.post(`/api/memory/update/${activeConvo.id}`, {}) } catch {}
    }
    const firstModel = availableModels[0] || null
    const convo = await api.post('/api/conversations', firstModel ? { model: firstModel } : {})
    setConversations(prev => [convo, ...prev])
    await selectConvo(convo)
  }

  async function deleteConvo(id) {
    await api.delete(`/api/conversations/${id}`)
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeConvo?.id === id) { setActiveConvo(null); setMessages([]) }
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

  function stopStreaming() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
  }

  async function sendMessage(contentOverride, skipSave = false) {
    const content = contentOverride
    const hasAttachments = attachments.length > 0
    if ((!content && !hasAttachments) || streaming || !activeConvo) return
    const attachmentsToSend = attachments
    setAttachments([])
    inputRef.current?.focus()

    const userId = `u_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const assistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2)}`
    setMessages(prev => [
      ...prev,
      // On regenerate (skipSave=true), don't add user message to UI again
      ...(skipSave ? [] : [{ id: userId, role: 'user', content, images: attachmentsToSend.length > 0 ? JSON.stringify(attachmentsToSend) : '' }]),
      { id: assistantId, role: 'assistant', content: '', think: '', streaming: true, actionRequests: [] }
    ])
    setStreaming(true)

    let assistantContent = ''
    let assistantThink = ''

    abortControllerRef.current = new AbortController()

    try {
      const endpoint = agentMode ? `/api/hermes/${activeConvo.id}` : `/api/chat/${activeConvo.id}`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, attachments: attachmentsToSend, skipSave }),
        signal: abortControllerRef.current.signal
      })

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let sseBuffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        sseBuffer += decoder.decode(value, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''
        const dataLines = lines.filter(l => l.startsWith('data: '))
        for (const line of dataLines) {
          try {
            const json = JSON.parse(line.slice(6))
            if (json.tool) {
              if (json.status === 'running') {
                setMessages(prev => prev.map(m =>
                  m.id === assistantId ? { ...m, toolStatus: `Searching: "${json.query}"` } : m
                ))
              } else if (json.status === 'done') {
                setMessages(prev => prev.map(m =>
                  m.id === assistantId ? { ...m, toolStatus: `Searched: "${json.query}" (${json.resultCount} results)` } : m
                ))
              }
            }
            if (json.think) {
              assistantThink += json.think
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, think: assistantThink, toolStatus: null } : m
              ))
            }
            if (json.token) {
              assistantContent += json.token
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: assistantContent, toolStatus: null } : m
              ))
            }
            if (json.usage) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, usage: json.usage } : m
              ))
            }
            if (json.done) {
              // Ollama liefert tokens (camelCase), Hermes usage (snake_case) — normalisieren,
              // damit der Token-Counter in Message.jsx in beiden Modi rendert
              const normalized = json.tokens ? {
                prompt_tokens: json.tokens.promptTokens,
                completion_tokens: json.tokens.completionTokens,
                total_tokens: json.tokens.totalTokens
              } : null
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, streaming: false, usage: normalized || m.usage } : m
              ))
            }
            if (json.error) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: `Error: ${json.error}`, streaming: false } : m
              ))
            }
            if (json.actionRequest) {
              const action = { actionId: json.actionId, description: json.description, command: json.command, type: json.type }
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, actionRequests: [action] } : m
              ))
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Stopped by user — mark as done
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, streaming: false, content: assistantContent || '_(stopped)_' } : m
        ))
      } else {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: `Connection error: ${err.message}`, streaming: false } : m
        ))
      }
    } finally {
      setStreaming(false)
      // Always clear per-message streaming flag — done event may not arrive
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, streaming: false } : m
      ))
      abortControllerRef.current = null
      loadConversations()
      // Reload messages from DB to replace temp string IDs with real integer IDs
      // (needed for delete/regenerate to work — temp IDs like "u_..." don't match DB rows)
      if (activeConvo) {
        try {
          const msgs = await api.get(`/api/conversations/${activeConvo.id}/messages`)
          setMessages(msgs)
        } catch {}
      }
      // Refocus input so user can keep typing without clicking
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  async function handleActionApprove(actionId, actionRequest) {
    try {
      await fetch('/api/hermes/run/' + actionId + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      // Agent continues streaming via SSE — final reload happens in sendMessage's finally block
    } catch (err) {
      console.error('Approve error:', err)
    }
  }

  async function handleActionDeny(actionId) {
    try {
      await fetch('/api/hermes/run/' + actionId + '/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      // Agent continues streaming via SSE — final reload happens in sendMessage's finally block
    } catch (err) {
      console.error('Deny error:', err)
    }
  }

  const deleteMessage = useCallback(async (msgId) => {
    try {
      await api.delete(`/api/conversations/message/${msgId}`)
      setMessages(prev => prev.filter(msg => msg.id !== msgId))
    } catch (err) {
      console.error('Delete message error:', err)
    }
  }, [])

  async function regenerate() {
    if (streaming || messages.length < 2) return
    // Find last user message
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    if (!lastUser) return
    // Remove last assistant message from UI
    setMessages(prev => {
      const idx = [...prev].reverse().findIndex(m => m.role === 'assistant')
      if (idx === -1) return prev
      const realIdx = prev.length - 1 - idx
      return prev.slice(0, realIdx)
    })
    // Remove last assistant message from DB
    try {
      await api.delete(`/api/conversations/${activeConvo.id}/last-assistant`)
    } catch {}
    await sendMessage(lastUser.content, true)
  }

  async function handleFileSelect(e) {
    const files = e.target.files
    if (!files || files.length === 0) return
    if (attachments.length + files.length > 5) {
      alert('Maximum 5 files per message')
      return
    }
    setUploading(true)
    try {
      const formData = new FormData()
      for (const f of files) formData.append('files', f)
      const res = await fetch('/api/uploads', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }))
        throw new Error(err.error || 'Upload failed')
      }
      const { files: uploaded } = await res.json()
      setAttachments(prev => [...prev, ...uploaded])
    } catch (err) {
      alert('Upload error: ' + err.message)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function removeAttachment(filename) {
    setAttachments(prev => prev.filter(a => a.filename !== filename))
  }

  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant')

  return (
    <div style={styles.root}>
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
          mobile={mobile}
        />
      )}

      <main style={styles.main}>
        <div style={styles.topbar}>
          <button style={styles.menuBtn} onClick={() => setMobileSidebar(v => !v)}>
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
              onClick={() => setAgentMode(m => !m)}
              title={agentMode ? "Agent mode ON" : "Agent mode OFF"}
            >
              <BoltIcon /> Agent
            </button>
          )}
          <ThemePicker />
          {activeConvo && (
            <button style={styles.settingsBtn} onClick={() => setShowSettings(true)} title="Settings">
              <GearIcon />
            </button>
          )}
        </div>

        <div style={styles.messages} ref={messagesContainerRef}>
          {!activeConvo && (
            <div style={styles.empty} className="fade-in">
              <div style={styles.emptyLogo}>
                <svg width="48" height="48" viewBox="0 0 32 32" fill="none">
                  <rect width="32" height="32" rx="8" fill="var(--accent)"/>
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
            <Message
              key={m.id}
              role={m.role}
              content={m.content}
              streaming={m.streaming}
              images={m.images}
              think={m.think}
              toolStatus={m.toolStatus}
              actionRequests={m.actionRequests}
              usage={m.usage}
              id={m.id}
              onDelete={deleteMessage}
              onApprove={handleActionApprove}
              onDeny={handleActionDeny}
            />
          ))}

          {activeConvo && !loading && messages.length === 0 && (
            <div style={styles.emptyChat}><p>Start the conversation below.</p></div>
          )}

          {showScrollBtn && (
            <button
              onClick={scrollToBottom}
              style={{
                position: 'fixed', left: 8, bottom: 150,
                width: 44, height: 44, minWidth: 44, minHeight: 44, borderRadius: '50%',
                background: 'var(--bg2)', border: '1px solid var(--border)',
                color: 'var(--text2)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                zIndex: 10, flexShrink: 0
              }}
              title="Scroll to bottom"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
          )}

          <div ref={messagesEndRef} />
        </div>

        {activeConvo && (
          <MessageInput
            streaming={streaming}
            attachments={attachments}
            uploading={uploading}
            onSend={(content) => sendMessage(content)}
            onStop={stopStreaming}
            onRegenerate={regenerate}
            onFileSelect={handleFileSelect}
            onRemoveAttachment={removeAttachment}
            showRegenerate={!streaming && !!lastAssistantMsg && messages.length >= 2}
            inputRef={inputRef}
          />
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

const styles = {
  root: { display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 },
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
    flex: 1, overflowY: 'auto', overflowX: 'hidden',
    padding: '24px 20px', display: 'flex', flexDirection: 'column',
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
    background: 'var(--accent)', color: 'var(--user-text, #0d0d0d)', fontWeight: 600,
    fontSize: 15, cursor: 'pointer', border: 'none', fontFamily: 'var(--font-sans)'
  },
  emptyChat: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 14 },
}
