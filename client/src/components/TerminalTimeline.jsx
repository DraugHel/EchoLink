import { useState } from 'react'

// Buendelt aufeinanderfolgende **Terminal:**-Messages zu einer kompakten Timeline.
export default function TerminalTimeline({ items, onDelete }) {
  const [open, setOpen] = useState({})

  const rows = items.map(m => {
    const c = m.content || ''
    const nl = c.indexOf('\n')
    const command = (nl === -1 ? c.slice(14) : c.slice(14, nl)).replace(/`/g, '')
    const output = nl === -1 ? '' : c.slice(nl + 1).replace(/^```\n?/, '').replace(/\n?```\s*$/, '')
    return { id: m.id, command, output, failed: output.startsWith('Exit code') }
  })

  return (
    <div style={{
      maxWidth: 820, width: '100%', margin: '0 auto 16px', flexShrink: 0,
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      fontFamily: 'var(--font-mono)', fontSize: 12, overflow: 'hidden'
    }}>
      <div style={{ padding: '6px 12px', color: 'var(--text3)', fontSize: 10,
        borderBottom: '1px solid var(--border)', letterSpacing: 0.5 }}>
        TERMINAL · {rows.length} {rows.length === 1 ? 'command' : 'commands'}
      </div>
      {rows.map(r => (
        <div key={r.id}>
          <div onClick={() => setOpen(o => ({ ...o, [r.id]: !o[r.id] }))}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
              cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: r.failed ? 'var(--danger)' : 'var(--accent)' }} />
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden',
              textOverflow: 'ellipsis', color: r.failed ? 'var(--danger)' : 'var(--text2)' }}>
              {r.command}
            </span>
            <span style={{ color: 'var(--text3)', flexShrink: 0 }}>{open[r.id] ? '\u25be' : '\u25b8'}</span>
          </div>
          {open[r.id] && (
            <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg1, var(--bg3))' }}>
              <pre style={{ margin: 0, padding: '8px 12px', maxHeight: 260, overflow: 'auto',
                whiteSpace: 'pre-wrap', color: 'var(--text2)', fontSize: 11 }}>
                {r.output || '(no output)'}
              </pre>
              {onDelete && (
                <div style={{ padding: '2px 12px 8px', textAlign: 'right' }}>
                  <button onClick={() => onDelete(r.id)}
                    style={{ background: 'none', border: 'none', color: 'var(--text3)',
                      fontSize: 10, cursor: 'pointer', fontFamily: 'var(--font-mono)' }}>
                    delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
