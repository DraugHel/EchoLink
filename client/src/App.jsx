import { useTheme } from './components/ThemePicker.jsx'
import { useState, useEffect, useRef } from 'react'
import Login from './pages/Login.jsx'
import Chat from './pages/Chat.jsx'
import api from './lib/api.js'

function useWakeLock() {
  const wakeLockRef = useRef(null)

  const acquire = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
      }
    } catch (e) {
      // Wake Lock not supported or denied — silently ignore
    }
  }

  const release = () => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release()
      wakeLockRef.current = null
    }
  }

  // Re-acquire on visibility change (e.g. switching back to the tab)
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        acquire()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      release()
    }
  }, [])

  return { acquire, release }
}

export default function App() {
  useTheme()
  const { acquire: acquireWakeLock, release: releaseWakeLock } = useWakeLock()
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    acquireWakeLock()
    api.get('/api/auth/me')
      .then(u => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))

    return () => releaseWakeLock()
  }, [])

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%' }}>
      <div style={{ width:24, height:24, border:'2px solid #2ecc71', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
    </div>
  )

  if (!user) return <Login onLogin={setUser} />
  return <Chat user={user} onLogout={() => setUser(null)} />
}
