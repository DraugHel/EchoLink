import { useState, useRef, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'

const LIGHT_THEMES = ['blossom']

function getCodeStyle() {
  const t = localStorage.getItem('echolink-theme') || 'echolink'
  return LIGHT_THEMES.includes(t) ? oneLight : oneDark
}

function Message({ role, content, streaming, images, think, toolStatus, actionRequests, onApprove, onDeny, onAlwaysAllow, usage, id, createdAt, prevCreatedAt, onDelete, editing, onEdit, onSaveEdit, onCancelEdit, retryFailed, onRetry }) {
  const [thinkOpen, setThinkOpen] = useState(false)
  const [termOpen, setTermOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)

  // Terminal-Output-Messages (aus dem chat.js Approve-Handler) erkennen
  const isTerminal = role === 'assistant' && typeof content === 'string'
    && content.startsWith('**Terminal:** ')
  let termCmd = '', termOutput = ''
  if (isTerminal) {
    const nl = content.indexOf('\n')
    termCmd = (nl === -1 ? content.slice(14) : content.slice(14, nl)).replace(/`/g, '')
    termOutput = nl === -1 ? ''
      : content.slice(nl + 1).replace(/^```\n?/, '').replace(/\n?```\s*$/, '')
  }
  const termFailed = isTerminal && termOutput.startsWith('Exit code')
  const [copied, setCopied] = useState(false)
  const [userCopied, setUserCopied] = useState(false)
  // Track approval state per actionId: { actionId: 'approved' | 'denied' }
  const [actionStates, setActionStates] = useState({})
  const [editText, setEditText] = useState('')
  const editRef = useRef(null)
  let parsedAttachments = []
  if (images) {
    try {
      const raw = JSON.parse(images)
      // Backward compat: old format was array of filename strings
      parsedAttachments = raw.map(it => typeof it === 'string'
        ? { filename: it, originalName: it, kind: 'image' }
        : it)
    } catch {}
  }
  const imgAttachments = parsedAttachments.filter(a => a.kind === 'image')
  const fileAttachments = parsedAttachments.filter(a => a.kind !== 'image')
  const isUser = role === 'user'

  function formatTime(ts) {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const isYesterday = d.toDateString() === yesterday.toDateString()
    const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    const date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
    if (sameDay) return 'Heute, ' + time
    if (isYesterday) return 'Gestern, ' + time
    return date + ', ' + time
  }

  const timeStr = formatTime(createdAt)
  // Timestamp nur zeigen, wenn >5 min seit der vorherigen Message vergangen sind
  const showTime = !prevCreatedAt || !createdAt || (createdAt - prevCreatedAt > 300)

  function handleApprove(actionId, actionRequest) {
    setActionStates(prev => ({ ...prev, [actionId]: 'approved' }))
    if (onApprove) onApprove(actionId, actionRequest)
  }

  function handleAlways(actionId, actionRequest) {
    setActionStates(prev => ({ ...prev, [actionId]: 'approved' }))
    if (onAlwaysAllow) onAlwaysAllow(actionId, actionRequest)
  }

  function handleDeny(actionId, actionRequest) {
    setActionStates(prev => ({ ...prev, [actionId]: 'denied' }))
    if (onDeny) onDeny(actionId, actionRequest)
  }

  return (
    <div style={{ ...styles.wrap, justifyContent: isUser ? 'flex-end' : 'flex-start' }} className="fade-in">
      {!isUser && (
        <div style={styles.avatar}>
          <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="var(--accent)"/>
            <path d="M8 22 L14 10 L20 18 L24 14" stroke="#0d0d0d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="24" cy="14" r="2" fill="#0d0d0d"/>
          </svg>
        </div>
      )}
      <div className="msg-bubble" style={{ ...styles.bubble, ...(isUser ? styles.userBubble : styles.aiBubble) }}>
        {isUser
          ? (
            <>
              <div style={{ ...styles.msgHeader, marginBottom: 4, justifyContent: 'space-between' }}>
                {timeStr && !streaming && showTime && (
                  <div style={{ fontSize: 10, color: 'rgba(13,13,13,0.45)', fontFamily: 'var(--font-mono)' }}>{timeStr}</div>
                )}
                <div className="msg-actions" style={{ display: 'flex', gap: 4 }}>
                  {onDelete && !editing && (
                    <button style={{ ...styles.copyBtn, color: 'rgba(13,13,13,0.4)' }}
                      onClick={() => onDelete(id)} title="Delete message">
                      <TrashIcon />
                    </button>
                  )}
                  {onEdit && !editing && (
                    <button style={{ ...styles.copyBtn, color: 'rgba(13,13,13,0.4)' }}
                      onClick={() => { setEditText(content || ''); onEdit(id) }} title="Edit message">
                      <EditIcon />
                    </button>
                  )}
                  <button style={{ ...styles.copyBtn, color: userCopied ? 'var(--green)' : 'rgba(13,13,13,0.4)' }}
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(content) }
                      catch { const t = document.createElement('textarea'); t.value = content; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t) }
                      setUserCopied(true); setTimeout(() => setUserCopied(false), 1500)
                    }} title="Copy message">
                    {userCopied ? <CheckIcon /> : <CopyIcon />}
                  </button>
                </div>
              </div>
              {imgAttachments.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: (content || fileAttachments.length > 0) ? 8 : 0 }}>
                  {imgAttachments.map(att => (
                    <img key={att.filename} src={`/api/uploads/${att.filename}`} alt="" style={{ maxWidth: 200, maxHeight: 200, borderRadius: 8, objectFit: 'cover' }} />
                  ))}
                </div>
              )}
              {fileAttachments.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: content ? 8 : 0 }}>
                  {fileAttachments.map(att => (
                    <a key={att.filename} href={`/api/uploads/${att.filename}`} download={att.originalName}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                        background: 'rgba(13,13,13,0.15)', borderRadius: 6, fontSize: 13,
                        color: '#0d0d0d', textDecoration: 'none', fontFamily: 'var(--font-mono)' }}>
                      📄 {att.originalName}
                    </a>
                  ))}
                </div>
              )}
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); onCancelEdit() }
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSaveEdit(id, editText) }
                    }}
                    autoFocus
                    style={{
                      width: '100%', minHeight: 60, resize: 'vertical',
                      background: 'rgba(13,13,13,0.08)', border: '1px solid rgba(13,13,13,0.2)',
                      borderRadius: 6, padding: '8px 10px', fontSize: 14,
                      color: '#0d0d0d', fontFamily: 'var(--font-mono)', outline: 'none',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button onClick={onCancelEdit}
                      style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderRadius: 6,
                        background: 'rgba(13,13,13,0.1)', color: '#0d0d0d', cursor: 'pointer' }}>
                      Cancel
                    </button>
                    <button onClick={() => onSaveEdit(id, editText)}
                      style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderRadius: 6,
                        background: 'var(--accent)', color: '#0d0d0d', cursor: 'pointer', fontWeight: 600 }}>
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                content && <p style={styles.userText}>{content}</p>
              )}
            </>
          )
          : (
            <div style={styles.markdown}>
              {timeStr && !streaming && showTime && (
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>{timeStr}</div>
              )}
              {toolStatus && (
                <div style={styles.toolStatus}>
                  <span style={styles.toolDot} />
                  {toolStatus}
                </div>
              )}
              {(actionRequests || []).map((ar, idx) => {
                const state = actionStates[ar.actionId]
                if (state === 'approved') {
                  return (
                    <div key={idx} style={{ ...styles.actionCard, borderLeft: '3px solid var(--green)' }}>
                      <span style={{ color: 'var(--green)', fontWeight: 600 }}>Approved</span>
                    </div>
                  )
                }
                if (state === 'denied') {
                  return (
                    <div key={idx} style={{ ...styles.actionCard, borderLeft: '3px solid var(--danger)' }}>
                      <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Denied</span>
                    </div>
                  )
                }
                return (
                  <div key={idx} style={styles.actionCard}>
                    <div style={styles.actionHeader}>
                      <ShieldIcon />
                      <span style={styles.actionTitle}>Action requires approval</span>
                    </div>
                    <p style={styles.actionDesc}>{ar.description}</p>
                    {ar.reason && (
                      <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 8px', fontFamily: 'var(--font-mono)' }}>
                        ({ar.reason})
                      </p>
                    )}
                    {ar.command && (
                      <code style={styles.actionCmd}>{ar.command}</code>
                    )}
                    <div style={styles.actionBtns}>
                      <button style={styles.approveBtn} onClick={() => handleApprove(ar.actionId, ar)}>
                        <CheckIcon2 /> Approve
                      </button>
                      <button style={styles.denyBtn} onClick={() => handleDeny(ar.actionId, ar)}>
                        <XIcon2 /> Deny
                      </button>
                      {ar.source === 'chat' &&
                        ar.type === 'shell' &&
                        onAlwaysAllow && (
                        <button style={{ ...styles.approveBtn, background: 'transparent',
                          border: '1px solid var(--border)', color: 'var(--text2)' }}
                          onClick={() => handleAlways(ar.actionId, ar)}
                          title="Diesen Command-Typ zur Auto-Approve-Liste hinzufuegen">
                          Immer erlauben
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              <div className="msg-actions" style={styles.msgHeader}>
                <button style={{ ...styles.copyBtn, color: copied ? 'var(--green)' : 'var(--text3)' }}
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(content) }
                    catch { const t = document.createElement('textarea'); t.value = content; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t) }
                    setCopied(true); setTimeout(() => setCopied(false), 1500)
                  }}
                  title="Copy response"
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
                {onDelete && (
                  <button style={{ ...styles.copyBtn, color: 'var(--text3)' }}
                    onClick={() => onDelete(id)}
                    title="Delete message"
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
              {think && (
                <div style={styles.thinkWrap}>
                  <button style={styles.thinkToggle} onClick={() => setThinkOpen(o => !o)}>
                    <span style={{ marginRight: 6 }}>{thinkOpen ? '▾' : '▸'}</span>
                    Thought process
                  </button>
                  {thinkOpen && (
                    <div style={styles.thinkContent}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{think}</ReactMarkdown>
                    </div>
                  )}
                </div>
              )}
              {isTerminal ? (
                <div style={styles.thinkWrap}>
                  <button style={styles.thinkToggle} onClick={() => setTermOpen(o => !o)}>
                    <span style={{ marginRight: 6 }}>{termOpen ? '\u25be' : '\u25b8'}</span>
                    <span style={termFailed ? { color: 'var(--danger)' } : undefined}>Terminal:</span> <code style={{ marginLeft: 4, ...(termFailed ? { color: 'var(--danger)' } : {}) }}>{termCmd}</code>
                  </button>
                  {termOpen && (
                    <pre style={{ ...styles.thinkContent, whiteSpace: 'pre-wrap', margin: 0 }}>
                      {termOutput}
                    </pre>
                  )}
                </div>
              ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ inline, className, children }) {
                    const lang = /language-(\w+)/.exec(className || '')?.[1]
                    return !inline && lang
                      ? <CodeBlock lang={lang} code={String(children).replace(/\n$/, '')} />
                      : <code style={styles.inlineCode}>{children}</code>
                  },
                  p: ({ children }) => <p style={{ marginBottom: 8 }}>{children}</p>,
                  ul: ({ children }) => <ul style={{ paddingLeft: 20, marginBottom: 8 }}>{children}</ul>,
                  ol: ({ children }) => <ol style={{ paddingLeft: 20, marginBottom: 8 }}>{children}</ol>,
                  li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
                  h1: ({ children }) => <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: 'var(--text)' }}>{children}</h1>,
                  h2: ({ children }) => <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>{children}</h2>,
                  h3: ({ children }) => <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{children}</h3>,
                  blockquote: ({ children }) => (
                    <blockquote style={{ borderLeft: '3px solid var(--green)', paddingLeft: 12, color: 'var(--text2)', margin: '8px 0' }}>
                      {children}
                    </blockquote>
                  ),
                  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
                  table: ({ children }) => (
                    <div style={{ overflowX: 'auto', maxWidth: '100%', marginBottom: 8, WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain' }}>
                      <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%', tableLayout: 'auto', fontSize: 14 }}>{children}</table>
                    </div>
                  ),
                  th: ({ children }) => <th style={{ border: '1px solid var(--border)', padding: '6px 12px', background: 'var(--bg3)', textAlign: 'left', minWidth: 120, wordBreak: 'normal', overflowWrap: 'break-word' }}>{children}</th>,
                  td: ({ children }) => <td style={{ border: '1px solid var(--border)', padding: '6px 12px', minWidth: 120, wordBreak: 'normal', overflowWrap: 'break-word' }}>{children}</td>,
                }}
              >
                {content}
              </ReactMarkdown>
              )}
              {streaming && <span className="echo-wave" aria-hidden="true"><span /><span /><span /><span /></span>}
              {retryFailed && !streaming && onRetry && (
                <button
                  onClick={() => onRetry(id)}
                  style={{
                    marginTop: 8, padding: '4px 12px', fontSize: 12, borderRadius: 6,
                    background: 'var(--accent)', color: '#fff', border: 'none',
                    cursor: 'pointer', fontWeight: 500
                  }}
                >
                  Retry
                </button>
              )}
              {!streaming && usage && (
                <div onClick={() => setUsageOpen(o => !o)} title="Tap for details"
                  style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6, fontFamily: 'var(--font-mono)', cursor: 'pointer', userSelect: 'none' }}>
                  {usageOpen
                    ? `${usage.prompt_tokens} in→${usage.completion_tokens} out (${usage.total_tokens} total)`
                    : `${usage.total_tokens} tok`}
                </div>
              )}
            </div>
          )
        }
      </div>
    </div>
  )
}

export default memo(Message)

const ShieldIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
)
const CheckIcon2 = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
)
const XIcon2 = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
)

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>
)
const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
)
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
)
const EditIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
)

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false)
  const [userCopied, setUserCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      // Fallback for older browsers / non-HTTPS
      const ta = document.createElement('textarea')
      ta.value = code
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch {}
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div style={{ position: 'relative', margin: '8px 0' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 10px 6px 12px', fontSize: 11, color: 'var(--text2)',
        background: '#1a1a1a', borderRadius: '8px 8px 0 0',
        fontFamily: 'var(--font-mono)', textTransform: 'lowercase',
        borderBottom: '1px solid var(--border)'
      }}>
        <span>{lang}</span>
        <button
          onClick={copy}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            color: copied ? 'var(--green)' : 'var(--text2)',
            fontSize: 11, fontFamily: 'var(--font-mono)',
            padding: '4px 8px', borderRadius: 4,
            transition: 'color var(--transition)',
            background: 'transparent', cursor: 'pointer'
          }}
        >
          {copied ? (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              copied
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              copy
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter style={getCodeStyle()} language={lang} PreTag="div"
        customStyle={{ borderRadius: '0 0 8px 8px', margin: 0, fontSize: 13 }}>
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', gap: 10, marginBottom: 16, alignItems: 'flex-start', maxWidth: 820, width: '100%', marginLeft: 'auto', marginRight: 'auto' },
  avatar: {
    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--green-bg)', border: '1px solid var(--green-dim)',
    marginTop: 2
  },
  bubble: { maxWidth: '80%', borderRadius: 12, padding: '12px 16px', fontSize: 15, lineHeight: 1.65, minWidth: 0 },
  userBubble: {
    background: 'var(--user-bubble, var(--accent))',
    color: 'var(--user-text, #0d0d0d)',
    borderBottomRightRadius: 4,
    fontWeight: 400
  },
  aiBubble: {
    background: 'var(--bg3)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    borderBottomLeftRadius: 4,
    width: '100%',
    maxWidth: '100%'
  },
  userText: { margin: 0 },
  markdown: { minWidth: 0, wordBreak: 'break-word', overflowWrap: 'break-word' },
  inlineCode: {
    background: 'var(--bg4)', padding: '1px 6px', borderRadius: 4,
    fontFamily: 'var(--font-mono)', fontSize: '0.88em', color: 'var(--green)',
    wordBreak: 'break-all', overflowWrap: 'break-word', whiteSpace: 'pre-wrap'
  },
  toolStatus: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    padding: '6px 10px', marginBottom: 8,
    fontSize: 12, color: 'var(--text2)',
    background: 'var(--accent-bg)',
    border: '1px solid var(--accent-dim)',
    borderRadius: 6, fontFamily: 'var(--font-mono)'
  },
  toolDot: {
    width: 6, height: 6, borderRadius: '50%',
    background: 'var(--accent)',
    animation: 'pulse 1.4s ease-in-out infinite'
  },
  actionCard: {
    marginBottom: 10, padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    borderLeft: '3px solid var(--accent)',
    background: 'var(--bg4)'
  },
  actionHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginBottom: 6
  },
  actionTitle: {
    fontWeight: 600, fontSize: 13,
    color: 'var(--accent)', fontFamily: 'var(--font-mono)'
  },
  actionDesc: {
    margin: 0, fontSize: 13, color: 'var(--text2)',
    marginBottom: 8
  },
  actionCmd: {
    display: 'block',
    padding: '6px 10px', borderRadius: 6,
    background: 'var(--bg3)', fontSize: 12,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text2)',
    marginBottom: 10,
    wordBreak: 'break-all'
  },
  actionBtns: {
    display: 'flex', gap: 8
  },
  approveBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '6px 14px', borderRadius: 6,
    background: 'var(--green-bg)', color: 'var(--green)',
    border: '1px solid var(--green-dim)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'var(--font-mono)', transition: 'all var(--transition)'
  },
  denyBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '6px 14px', borderRadius: 6,
    background: 'transparent', color: 'var(--danger)',
    border: '1px solid var(--danger)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'var(--font-mono)', transition: 'all var(--transition)'
  },
  msgHeader: {
    display: 'flex', justifyContent: 'flex-end',
    marginBottom: 4
  },
  copyBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '2px 4px', borderRadius: 4,
    transition: 'color var(--transition)',
    display: 'flex', alignItems: 'center'
  },
  thinkWrap: {
    marginBottom: 10,
    borderRadius: 8,
    border: '1px solid var(--border)',
    overflow: 'hidden'
  },
  thinkToggle: {
    width: '100%', textAlign: 'left',
    padding: '7px 12px', fontSize: 12,
    color: 'var(--text2)', background: 'var(--bg4)',
    cursor: 'pointer', fontFamily: 'var(--font-mono)',
    display: 'flex', alignItems: 'center',
    border: 'none'
  },
  thinkContent: {
    padding: '10px 12px', fontSize: 13,
    color: 'var(--text2)', background: 'var(--bg3)',
    lineHeight: 1.5, maxHeight: 300, overflowY: 'auto',
    fontFamily: 'var(--font-mono)'
  },
  cursor: {
    display: 'inline-block', width: 2, height: '1em',
    background: 'var(--green)', marginLeft: 2, verticalAlign: 'text-bottom',
    animation: 'pulse 0.8s ease infinite'
  }
}