import { useTheme } from './components/ThemePicker.jsx'
import { useState, useEffect } from 'react'
import Login from './pages/Login.jsx'
import Chat from './pages/Chat.jsx'
import api from './lib/api.js'

export default function App() {
  useTheme()
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/api/auth/me')
      .then(u => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%' }}>
      <div style={{ width:24, height:24, border:'2px solid #2ecc71', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
    </div>
  )

  if (!user) return <Login onLogin={setUser} />
  return <Chat user={user} onLogout={() => setUser(null)} />
}
