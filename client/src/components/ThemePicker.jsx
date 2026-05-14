import { useState, useEffect, useRef } from 'react'

const THEMES = [
  { id: 'echolink', label: 'EchoLink', color: '#2ecc71', bg: '#0d0d0d' },
  { id: 'sakura',   label: 'Sakura',   color: '#f472b6', bg: '#0f0a0d' },
  { id: 'void',     label: 'Void',     color: '#00e5ff', bg: '#060611' },
]

function applyTheme(id) {
  document.documentElement.classList.remove(...THEMES.map(t => `theme-${t.id}`))
  if (id !== 'echolink') document.documentElement.classList.add(`theme-${id}`)
  localStorage.setItem('echolink-theme', id)
}

export function useTheme() {
  useEffect(() => {
    const saved = localStorage.getItem('echolink-theme') || 'echolink'
    applyTheme(saved)
  }, [])
}

export default function ThemePicker() {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState(() => localStorage.getItem('echolink-theme') || 'echolink')
  const ref = useRef(null)

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function select(id) {
    applyTheme(id)
    setCurrent(id)
    setOpen(false)
  }

  const theme = THEMES.find(t => t.id === current)

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Change theme"
        style={{
          width: 28, height: 28, borderRadius: '50%',
          background: theme.color, border: '2px solid var(--border2)',
          cursor: 'pointer', flexShrink: 0,
          boxShadow: open ? `0 0 0 2px ${theme.color}40` : 'none',
          transition: 'box-shadow 150ms ease'
        }}
      />
      {open && (
        <div style={{
          position: 'absolute', top: 36, right: 0,
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 12, padding: 8, display: 'flex', flexDirection: 'column',
          gap: 4, zIndex: 300, minWidth: 130,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
        }} className="fade-in">
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => select(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                background: current === t.id ? 'var(--accent-bg)' : 'transparent',
                border: current === t.id ? '1px solid var(--accent-dim)' : '1px solid transparent',
                color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font-sans)'
              }}
            >
              <span style={{ width: 14, height: 14, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
              {t.label}
              {current === t.id && <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 11 }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
