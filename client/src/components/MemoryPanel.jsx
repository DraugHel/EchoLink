import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import api from '../lib/api.js'

export default function MemoryPanel({
  conversationId,
  streaming,
  onClose
}) {
  const [memory, setMemory] = useState('')
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState('')

  async function loadMemory() {
    setLoading(true)
    setError('')

    try {
      const data = await api.get('/api/memory')
      setMemory(data?.memory || '')
    } catch (err) {
      setError(err?.message || 'Memory konnte nicht geladen werden.')
    } finally {
      setLoading(false)
    }
  }

  async function updateMemory() {
    if (!conversationId || streaming) return

    setUpdating(true)
    setError('')

    try {
      const data = await api.post(
        `/api/memory/update/${conversationId}`,
        {}
      )

      if (typeof data?.memory === 'string') {
        setMemory(data.memory)
      } else {
        await loadMemory()
      }
    } catch (err) {
      setError(
        err?.message || 'Memory konnte nicht aktualisiert werden.'
      )
    } finally {
      setUpdating(false)
    }
  }

  useEffect(() => {
    loadMemory()
  }, [])

  const factCount = memory
    .split('\n')
    .filter(line => /^\s*[-*]\s+/.test(line))
    .length

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0,0,0,0.68)',
        backdropFilter: 'blur(3px)'
      }}
    >
      <section
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(680px, 100%)',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          borderRadius: 14,
          background: 'var(--bg2)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.55)'
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <div style={{ flex: 1 }}>
            <strong
              style={{
                color: 'var(--text1)',
                fontFamily: 'var(--font-mono)'
              }}
            >
              User Memory
            </strong>

            <div
              style={{
                marginTop: 3,
                color: 'var(--text3)',
                fontSize: 11
              }}
            >
              {factCount > 0
                ? `${factCount} gespeicherte ${factCount === 1 ? 'Information' : 'Informationen'}`
                : 'Wird in Non-Agent-Chats in den Kontext eingefügt.'}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            style={{
              width: 34,
              height: 34,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg3)',
              color: 'var(--text2)',
              fontSize: 20,
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </header>

        <div
          style={{
            minHeight: 220,
            flex: 1,
            overflowY: 'auto',
            padding: 16
          }}
        >
          {loading ? (
            <div style={{ color: 'var(--text3)' }}>
              Memory wird geladen …
            </div>
          ) : memory ? (
            <div
              style={{
                color: 'var(--text1)',
                fontSize: 13,
                lineHeight: 1.6,
                overflowWrap: 'anywhere'
              }}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => (
                    <h2
                      style={{
                        margin: '18px 0 8px',
                        paddingBottom: 7,
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--accent)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: '0.04em'
                      }}
                    >
                      {children}
                    </h2>
                  ),

                  h2: ({ children }) => (
                    <h2
                      style={{
                        margin: '18px 0 8px',
                        paddingBottom: 7,
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--accent)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: '0.04em'
                      }}
                    >
                      {children}
                    </h2>
                  ),

                  h3: ({ children }) => (
                    <h3
                      style={{
                        margin: '14px 0 7px',
                        color: 'var(--text2)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        fontWeight: 700
                      }}
                    >
                      {children}
                    </h3>
                  ),

                  ul: ({ children }) => (
                    <ul
                      style={{
                        margin: '4px 0 14px',
                        paddingLeft: 22
                      }}
                    >
                      {children}
                    </ul>
                  ),

                  ol: ({ children }) => (
                    <ol
                      style={{
                        margin: '4px 0 14px',
                        paddingLeft: 24
                      }}
                    >
                      {children}
                    </ol>
                  ),

                  li: ({ children }) => (
                    <li
                      style={{
                        margin: '7px 0',
                        paddingLeft: 3,
                        color: 'var(--text1)'
                      }}
                    >
                      {children}
                    </li>
                  ),

                  p: ({ children }) => (
                    <p
                      style={{
                        margin: '7px 0',
                        color: 'var(--text1)'
                      }}
                    >
                      {children}
                    </p>
                  ),

                  strong: ({ children }) => (
                    <strong
                      style={{
                        color: 'var(--text1)',
                        fontWeight: 700
                      }}
                    >
                      {children}
                    </strong>
                  ),

                  code: ({ children }) => (
                    <code
                      style={{
                        padding: '2px 5px',
                        borderRadius: 5,
                        background: 'var(--bg3)',
                        color: 'var(--accent)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.92em'
                      }}
                    >
                      {children}
                    </code>
                  )
                }}
              >
                {memory}
              </ReactMarkdown>
            </div>
          ) : (
            <div
              style={{
                padding: 30,
                textAlign: 'center',
                color: 'var(--text3)'
              }}
            >
              Noch keine Memory gespeichert.
            </div>
          )}

          {error && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                border: '1px solid var(--danger)',
                borderRadius: 8,
                color: 'var(--danger)',
                fontSize: 12
              }}
            >
              {error}
            </div>
          )}
        </div>

        <footer
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
            borderTop: '1px solid var(--border)'
          }}
        >
          <button
            type="button"
            onClick={loadMemory}
            disabled={loading || updating}
            style={{
              padding: '9px 12px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg3)',
              color: 'var(--text2)',
              cursor: 'pointer'
            }}
          >
            Neu laden
          </button>

          <button
            type="button"
            onClick={updateMemory}
            disabled={loading || updating || streaming}
            style={{
              padding: '9px 14px',
              border: 0,
              borderRadius: 8,
              background: 'var(--accent)',
              color: 'var(--user-text, #0d0d0d)',
              fontWeight: 700,
              cursor: streaming ? 'not-allowed' : 'pointer',
              opacity: loading || updating || streaming ? 0.55 : 1
            }}
          >
            {updating ? 'Aktualisiere …' : 'Memory aktualisieren'}
          </button>
        </footer>
      </section>
    </div>
  )
}
