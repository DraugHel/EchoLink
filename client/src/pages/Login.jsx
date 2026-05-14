import { useState } from 'react'
import api from '../lib/api.js'

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const user = await api.post('/api/auth/login', { username, password })
      onLogin(user)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card} className="fade-in">
        <div style={styles.logo}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="var(--accent)"/>
            <path d="M8 22 L14 10 L20 18 L24 14" stroke="#0d0d0d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="24" cy="14" r="2" fill="#0d0d0d"/>
          </svg>
          <span style={styles.logoText}>Echo<span style={{ color:'var(--green)' }}>Link</span></span>
        </div>

        <p style={styles.sub}>Sign in to continue</p>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.form} onKeyDown={e => e.key === 'Enter' && handleSubmit(e)}>
          <input
            style={styles.input}
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <button style={{ ...styles.btn, opacity: loading ? 0.6 : 1 }} onClick={handleSubmit} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles = {
  wrap: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    padding: '24px'
  },
  card: {
    width: '100%',
    maxWidth: 360,
    background: 'var(--bg2)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    padding: '40px 32px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4
  },
  logoText: {
    fontFamily: 'var(--font-mono)',
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--text)'
  },
  sub: {
    color: 'var(--text2)',
    fontSize: 14,
    marginBottom: 8
  },
  error: {
    background: 'rgba(231,76,60,0.1)',
    border: '1px solid rgba(231,76,60,0.3)',
    borderRadius: 8,
    padding: '10px 14px',
    color: '#e74c3c',
    fontSize: 14
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  input: {
    padding: '12px 14px',
    width: '100%',
    fontSize: 16
  },
  btn: {
    marginTop: 4,
    padding: '13px',
    background: 'var(--green)',
    color: '#0d0d0d',
    fontWeight: 600,
    fontSize: 15,
    borderRadius: 'var(--radius)',
    transition: 'opacity var(--transition)',
    cursor: 'pointer',
    border: 'none',
    fontFamily: 'var(--font-sans)'
  }
}
