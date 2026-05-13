import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// iOS keyboard fix — scroll window back to top when keyboard closes
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
  window.addEventListener('focusout', () => {
    setTimeout(() => window.scrollTo(0, 0), 100)
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
