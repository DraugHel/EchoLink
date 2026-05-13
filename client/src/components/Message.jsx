import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

export default function Message({ role, content, streaming, images }) {
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

  return (
    <div style={{ ...styles.wrap, justifyContent: isUser ? 'flex-end' : 'flex-start' }} className="fade-in">
      {!isUser && (
        <div style={styles.avatar}>
          <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#2ecc71"/>
            <path d="M8 22 L14 10 L20 18 L24 14" stroke="#0d0d0d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="24" cy="14" r="2" fill="#0d0d0d"/>
          </svg>
        </div>
      )}
      <div style={{ ...styles.bubble, ...(isUser ? styles.userBubble : styles.aiBubble) }}>
        {isUser
          ? (
            <>
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
              {content && <p style={styles.userText}>{content}</p>}
            </>
          )
          : (
            <div style={styles.markdown}>
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
                    <div style={{ overflowX: 'auto', marginBottom: 8 }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>{children}</table>
                    </div>
                  ),
                  th: ({ children }) => <th style={{ border: '1px solid var(--border)', padding: '6px 12px', background: 'var(--bg3)', textAlign: 'left' }}>{children}</th>,
                  td: ({ children }) => <td style={{ border: '1px solid var(--border)', padding: '6px 12px' }}>{children}</td>,
                }}
              >
                {content}
              </ReactMarkdown>
              {streaming && <span style={styles.cursor} />}
            </div>
          )
        }
      </div>
    </div>
  )
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false)

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
      <SyntaxHighlighter style={oneDark} language={lang} PreTag="div"
        customStyle={{ borderRadius: '0 0 8px 8px', margin: 0, fontSize: 13 }}>
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', gap: 10, marginBottom: 16, alignItems: 'flex-start', maxWidth: '100%' },
  avatar: {
    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--green-bg)', border: '1px solid var(--green-dim)',
    marginTop: 2
  },
  bubble: { maxWidth: '80%', borderRadius: 12, padding: '12px 16px', fontSize: 15, lineHeight: 1.65 },
  userBubble: {
    background: 'var(--green)',
    color: '#0d0d0d',
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
  markdown: { minWidth: 0 },
  inlineCode: {
    background: 'var(--bg4)', padding: '1px 6px', borderRadius: 4,
    fontFamily: 'var(--font-mono)', fontSize: '0.88em', color: 'var(--green)'
  },
  cursor: {
    display: 'inline-block', width: 2, height: '1em',
    background: 'var(--green)', marginLeft: 2, verticalAlign: 'text-bottom',
    animation: 'pulse 0.8s ease infinite'
  }
}
