import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

export default function Message({ role, content, streaming }) {
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
          ? <p style={styles.userText}>{content}</p>
          : (
            <div style={styles.markdown}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ inline, className, children }) {
                    const lang = /language-(\w+)/.exec(className || '')?.[1]
                    return !inline && lang
                      ? (
                        <SyntaxHighlighter style={oneDark} language={lang} PreTag="div"
                          customStyle={{ borderRadius: 8, margin: '8px 0', fontSize: 13 }}>
                          {String(children).replace(/\n$/, '')}
                        </SyntaxHighlighter>
                      )
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

const styles = {
  wrap: { display: 'flex', gap: 10, marginBottom: 16, alignItems: 'flex-start', maxWidth: '100%', overflow: 'hidden' },
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
