import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// iOS viewport fix: track visualViewport to handle keyboard + address bar
function updateViewport() {
  const vv = window.visualViewport
  const h = vv ? vv.height : window.innerHeight
  document.documentElement.style.setProperty('--app-height', `${h}px`)
}

updateViewport()
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateViewport)
  window.visualViewport.addEventListener('scroll', updateViewport)
}
window.addEventListener('resize', updateViewport)
window.addEventListener('orientationchange', updateViewport)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
