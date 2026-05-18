import { useEffect, useRef } from 'react'
import Message from './Message.jsx'

export default function MessageList({ activeConvo, messages, loading, onApprove, onDeny, onCreateConvo }) {
  const messagesEndRef = useRef(null)
  const prevMsgCount = useRef(0)

  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevMsgCount.current = messages.length
  }, [messages])

  if (!activeConvo) {
    return (
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
        <button style={styles.emptyBtn} onClick={onCreateConvo}>+ New Conversation</button>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ display:'flex', justifyContent:'center', paddingTop: 40 }}>
        <div style={{ width:20, height:20, border:'2px solid var(--green)', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div style={styles.emptyChat}><p>Start the conversation below.</p></div>
    )
  }

  return (
    <>
      {messages.map(m => (
        <Message
          key={m.id}
          role={m.role}
          content={m.content}
          streaming={m.streaming}
          images={m.images}
          think={m.think}
          toolStatus={m.toolStatus}
          actionRequest={m.actionRequests?.[0]}
          onApprove={m.actionRequests?.[0] ? () => onApprove(m.actionRequests[0].actionId, m.actionRequests[0]) : undefined}
          onDeny={m.actionRequests?.[0] ? () => onDeny(m.actionRequests[0].actionId) : undefined}
        />
      ))}
      <div ref={messagesEndRef} />
    </>
  )
}

const styles = {
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