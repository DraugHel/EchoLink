import { Component, lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react'
import Sidebar from '../components/Sidebar.jsx'
import Message from '../components/Message.jsx'
import MessageInput from '../components/MessageInput.jsx'
import AppToolsMenu from '../components/AppToolsMenu.jsx'
import api from '../lib/api.js'
import { useTheme } from '../components/ThemePicker.jsx'
import CorsnFace from '../components/CorsnFace.jsx'
import LunaMiniHud from '../components/LunaMiniHud.jsx'
import TerminalTimeline from '../components/TerminalTimeline.jsx'

// EchoLink UI Phase 3.1: lazy tool panels
const SettingsPanel = lazy(
  () => import('../components/SettingsPanel.jsx')
)
const MemoryPanel = lazy(
  () => import('../components/MemoryPanel.jsx')
)
const TaskPanel = lazy(
  () => import('../components/TaskPanel.jsx')
)
const ShiftImporter = lazy(
  () => import('../components/ShiftImporter.jsx')
)
const SystemStatusPanel = lazy(
  () => import('../components/SystemStatusPanel.jsx')
)
const ChatAgentCockpit = lazy(
  () => import('../components/ChatAgentCockpit.jsx')
)

let chatRunStateModulePromise

function loadChatRunStateModule() {
  if (!chatRunStateModulePromise) {
    chatRunStateModulePromise = import(
      '../lib/chatRunState.js'
    )
  }

  return chatRunStateModulePromise
}

function ToolPanelFallback({ label }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1400,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding:
          'env(safe-area-inset-top) 16px env(safe-area-inset-bottom)',
        background: 'var(--bg2)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--bg3)',
          color: 'var(--text2)',
          fontFamily: 'var(--font-mono)',
          fontSize: 12
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 18,
            height: 18,
            flex: '0 0 auto',
            boxSizing: 'border-box',
            border: '2px solid var(--border2)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'spin 0.7s linear infinite'
          }}
        />
        <span>{label} wird geladen …</span>
      </div>
    </div>
  )
}


// EchoLink UI Phase 3.2: lazy tool error boundary
class ToolPanelErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error(
      `Lazy-Panel ${this.props.label} konnte nicht geladen werden.`,
      error,
      info
    )
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1400,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding:
            'env(safe-area-inset-top) 16px env(safe-area-inset-bottom)',
          background: 'var(--bg2)'
        }}
      >
        <div
          style={{
            width: 'min(100%, 360px)',
            boxSizing: 'border-box',
            padding: 16,
            border: '1px solid var(--border)',
            borderRadius: 12,
            background: 'var(--bg3)',
            boxShadow: '0 18px 50px rgba(0, 0, 0, 0.28)'
          }}
        >
          <div
            style={{
              color: 'var(--text1)',
              fontWeight: 700,
              marginBottom: 6
            }}
          >
            {this.props.label} konnte nicht geladen werden
          </div>

          <div
            style={{
              color: 'var(--text2)',
              fontSize: 13,
              lineHeight: 1.5,
              marginBottom: 14
            }}
          >
            Prüfe kurz die Verbindung und lade EchoLink neu.
            Deine Daten wurden dadurch nicht verändert.
          </div>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8
            }}
          >
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                minHeight: 40,
                padding: '8px 12px',
                border: '1px solid var(--accent-dim)',
                borderRadius: 8,
                background: 'var(--accent-bg)',
                color: 'var(--accent)',
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              EchoLink neu laden
            </button>

            <button
              type="button"
              onClick={this.props.onClose}
              style={{
                minHeight: 40,
                padding: '8px 12px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg2)',
                color: 'var(--text2)',
                cursor: 'pointer'
              }}
            >
              Schließen
            </button>
          </div>
        </div>
      </div>
    )
  }
}

async function readResponseError(response) {
  const contentType = response.headers.get('content-type') || ''
  let message = ''

  try {
    if (contentType.includes('application/json')) {
      const data = await response.json()
      message = data?.error || data?.message || ''
    } else {
      message = (await response.text()).trim()
    }
  } catch {
    // Der urspruengliche HTTP-Status bleibt als Fallback erhalten.
  }

  // Komplette HTML-Fehlerseiten von Proxies nicht in den Chat kippen.
  if (message.startsWith('<!DOCTYPE') || message.startsWith('<html')) {
    message = ''
  }

  const error = new Error(
    message || response.statusText || `HTTP ${response.status}`
  )
  error.status = response.status
  error.retryable = response.status === 408 ||
    response.status === 429 ||
    response.status >= 500

  return error
}

function parseSseEvent(rawEvent) {
  const data = rawEvent
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')

  if (!data) return null

  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function formatDuration(seconds) {
  if (
    seconds == null ||
    !Number.isFinite(Number(seconds))
  ) {
    return '–'
  }

  const value = Math.max(
    0,
    Math.floor(Number(seconds))
  )

  const days = Math.floor(value / 86400)
  const hours = Math.floor(
    value % 86400 / 3600
  )
  const minutes = Math.floor(
    value % 3600 / 60
  )

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  return `${minutes}m`
}

function formatBackupAge(backup) {
  if (!backup?.found) return 'fehlt'
  return `vor ${formatDuration(backup.ageSeconds)}`
}

function metricColor(value, warning, critical) {
  if (
    value == null ||
    !Number.isFinite(Number(value))
  ) {
    return 'var(--text3)'
  }

  if (Number(value) >= critical) {
    return 'var(--danger)'
  }

  if (Number(value) >= warning) {
    return '#e7b955'
  }

  return 'var(--text2)'
}


// EchoLink Phase 5.1: Luna Presence Mode
function normalizeLunaToolStatus(value) {
  if (!value) return ''

  if (typeof value === 'string') {
    return value.trim()
  }

  if (Array.isArray(value)) {
    return value
      .map(normalizeLunaToolStatus)
      .filter(Boolean)
      .join(', ')
  }

  if (typeof value === 'object') {
    const preferred =
      value.message ||
      value.label ||
      value.description ||
      value.status ||
      value.tool ||
      value.name

    return normalizeLunaToolStatus(preferred)
  }

  return String(value).trim()
}

function getLunaToolText(value) {
  const raw = normalizeLunaToolStatus(value)

  if (!raw) return ''

  const compact = raw
    .replace(/\s+/g, ' ')
    .trim()

  if (/gmail|e-?mail|mailbox/i.test(compact)) {
    return 'Luna durchsucht Gmail …'
  }

  if (/calendar|kalender|termin/i.test(compact)) {
    return 'Luna schaut in den Kalender …'
  }

  if (/web|search|suche|searx|browse/i.test(compact)) {
    return 'Luna durchsucht das Web …'
  }

  if (/terminal|shell|command|befehl|exec/i.test(compact)) {
    return 'Luna führt einen Befehl aus …'
  }

  if (/upload|attachment|anhang|datei|file/i.test(compact)) {
    return 'Luna liest eine Datei …'
  }

  if (/memory|gedächtnis|gedaechtnis|erinner/i.test(compact)) {
    return 'Luna schaut ins Gedächtnis …'
  }

  if (/task|aufgabe|scheduler/i.test(compact)) {
    return 'Luna arbeitet an einer Aufgabe …'
  }

  if (/tool|werkzeug/i.test(compact)) {
    return 'Luna benutzt ein Werkzeug …'
  }

  return compact.toLowerCase().startsWith('luna')
    ? compact
    : `Luna arbeitet: ${compact}`
}


function formatLunaToolEvent(event) {
  const rawName = String(event?.tool || '').trim()

  if (!rawName) return ''

  const readableName = rawName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const status = String(event?.status || '')
    .trim()
    .toLowerCase()

  const statusText =
    status === 'running'
      ? 'läuft'
      : status === 'done'
        ? 'fertig'
        : status === 'error'
          ? 'Fehler'
          : status || 'aktiv'

  const query = typeof event?.query === 'string'
    ? event.query.trim()
    : ''

  const showQuery =
    query &&
    /web|search|scrape|terminal/i.test(rawName)

  return `${readableName} · ${statusText}${
    showQuery ? `: ${query}` : ''
  }`
}


// EchoLink Phase 5.2: Luna Reactions
function getLunaToolKind(value) {
  const raw = normalizeLunaToolStatus(value)

  if (!raw) return ''

  if (/gmail|e-?mail|mailbox/i.test(raw)) return 'gmail'
  if (/calendar|kalender|termin/i.test(raw)) return 'calendar'
  if (/terminal|shell|command|befehl|exec/i.test(raw)) return 'terminal'
  if (/upload|attachment|anhang|datei|file/i.test(raw)) return 'file'
  if (/memory|gedächtnis|gedaechtnis|erinner/i.test(raw)) return 'memory'
  if (/task|aufgabe|scheduler/i.test(raw)) return 'task'
  if (/web|search|suche|searx|browse/i.test(raw)) return 'web'

  return 'tool'
}

function getLunaPresenceSymbol(kind) {
  const symbols = {
    alert: '!',
    approval: '?',
    thought: '◇',
    speech: '◌',
    success: '✓',
    gmail: '✉',
    calendar: '▣',
    web: '⌕',
    terminal: '›',
    file: '▤',
    memory: '◆',
    task: '✓',
    tool: '✦'
  }

  return symbols[kind] || '•'
}

function estimateLunaContextTokens(value) {
  const text = String(value || '')
  if (!text) return 0
  return Math.ceil(text.length / 3.2)
}

function createLunaLiveContext({
  assistantId,
  usage,
  messages,
  content,
  attachments,
  skipSave,
  model
}) {
  const budget = Number(
    usage?.context_budget_tokens
  )
  const previousInput = Number(
    usage?.context_estimated_input_tokens
  )

  if (
    !Number.isFinite(budget) ||
    budget <= 0 ||
    !Number.isFinite(previousInput)
  ) {
    return null
  }

  let estimatedInput = previousInput

  if (!skipSave) {
    const sourceAssistant = [...messages]
      .reverse()
      .find(message =>
        message.role === 'assistant' &&
        !message.streaming
      )

    const exactPreviousOutput = Number(
      usage?.completion_tokens
    )

    if (Number.isFinite(exactPreviousOutput)) {
      estimatedInput += Math.max(
        0,
        exactPreviousOutput
      ) + 8
    } else if (sourceAssistant) {
      estimatedInput +=
        estimateLunaContextTokens(
          sourceAssistant.content
        ) +
        estimateLunaContextTokens(
          sourceAssistant.think
        ) +
        8
    }

    estimatedInput +=
      estimateLunaContextTokens(content) + 8

    estimatedInput += (attachments || [])
      .filter(attachment =>
        attachment?.kind === 'image'
      )
      .length * 1600
  }

  return {
    assistantId,
    usage: {
      ...usage,
      context_estimated_input_tokens:
        estimatedInput,
      context_live_output_tokens: 0,
      context_live: true,
      context_model: model ||
        usage?.context_model ||
        ''
    }
  }
}

function useIsMobile() {
  const [mobile, setMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return mobile
}

export default function Chat({ user, onLogout }) {
  const [conversations, setConversations] = useState([])
  const [activeConvo, setActiveConvo] = useState(null)
  const [messages, setMessages] = useState([])
  const [streaming, setStreaming] = useState(false)
  const [sysStatus, setSysStatus] = useState(null)
  const [sysStatusUpdatedAt, setSysStatusUpdatedAt] = useState(null)
  const [showSysPanel, setShowSysPanel] = useState(false)
  const [showLunaHud, setShowLunaHud] = useState(false)
  const [lunaLiveContext, setLunaLiveContext] = useState(null)
  const [lunaResolvedContext, setLunaResolvedContext] = useState(null)
  const [chatRun, setChatRun] = useState(null)
  const [monitoredApps, setMonitoredApps] = useState(() => { try { const saved = localStorage.getItem('echolink.monitoredApps'); return saved ? JSON.parse(saved) : ['echolink', 'echolink-worker'] } catch { return ['echolink', 'echolink-worker'] } })
  const [showSettings, setShowSettings] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [showShiftImporter, setShowShiftImporter] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [jumpMessageId, setJumpMessageId] = useState(null)
  const [showLunaDone, setShowLunaDone] = useState(false)
  const [lunaIdle, setLunaIdle] = useState(false)
  const lunaHudRef = useRef(null)
  const lunaButtonRef = useRef(null)
  const wasStreamingRef = useRef(false)

  useEffect(() => {
    let doneTimer

    if (streaming) {
      setShowLunaDone(false)
    } else if (wasStreamingRef.current) {
      setShowLunaDone(true)

      doneTimer = window.setTimeout(() => {
        setShowLunaDone(false)
      }, 2200)
    }

    wasStreamingRef.current = streaming

    return () => {
      if (doneTimer) {
        window.clearTimeout(doneTimer)
      }
    }
  }, [streaming])

  useEffect(() => {
    let idleTimer

    const scheduleLunaSleep = () => {
      setLunaIdle(false)

      if (idleTimer) {
        window.clearTimeout(idleTimer)
      }

      if (!streaming) {
        idleTimer = window.setTimeout(() => {
          setLunaIdle(true)
        }, 90000)
      }
    }

    scheduleLunaSleep()

    window.addEventListener(
      'pointerdown',
      scheduleLunaSleep,
      { passive: true }
    )
    window.addEventListener(
      'keydown',
      scheduleLunaSleep
    )

    return () => {
      if (idleTimer) {
        window.clearTimeout(idleTimer)
      }

      window.removeEventListener(
        'pointerdown',
        scheduleLunaSleep
      )
      window.removeEventListener(
        'keydown',
        scheduleLunaSleep
      )
    }
  }, [
    streaming,
    activeConvo?.id,
    messages.length
  ])

  useEffect(() => {
    if (!showLunaHud) return

    const handleOutsidePointer = event => {
      if (
        lunaHudRef.current?.contains(event.target) ||
        lunaButtonRef.current?.contains(event.target)
      ) {
        return
      }

      setShowLunaHud(false)
    }

    const handleEscape = event => {
      if (event.key === 'Escape') {
        setShowLunaHud(false)
        lunaButtonRef.current?.focus()
      }
    }

    document.addEventListener(
      'pointerdown',
      handleOutsidePointer
    )
    document.addEventListener(
      'keydown',
      handleEscape
    )

    return () => {
      document.removeEventListener(
        'pointerdown',
        handleOutsidePointer
      )
      document.removeEventListener(
        'keydown',
        handleEscape
      )
    }
  }, [showLunaHud])

  useEffect(() => {
    setShowLunaHud(false)
    setLunaLiveContext(null)
    setLunaResolvedContext(null)
    setChatRun(null)
  }, [activeConvo?.id])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    async function handlePushMessage(event) {
      if (event.data?.type !== 'ECHOLINK_PUSH') return

      const rawConversationId =
        event.data?.payload?.conversationId

      const pushedConversationId =
        rawConversationId == null
          ? null
          : Number(rawConversationId)

      try {
        const convos = await api.get('/api/conversations?includeArchived=1')

        if (Array.isArray(convos)) {
          setConversations(convos)
        }

        const activeId = Number(activeConvo?.id)
        const hasTarget =
          Number.isInteger(pushedConversationId) &&
          pushedConversationId > 0

        if (
          activeId > 0 &&
          (!hasTarget || pushedConversationId === activeId)
        ) {
          const msgs = await api.get(
            `/api/conversations/${activeId}/messages`
          )

          setMessages(msgs)
        }
      } catch (error) {
        console.error(
          'Push refresh failed:',
          error?.message || error
        )
      }
    }

    navigator.serviceWorker.addEventListener(
      'message',
      handlePushMessage
    )

    return () => {
      navigator.serviceWorker.removeEventListener(
        'message',
        handlePushMessage
      )
    }
  }, [activeConvo?.id])
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const [availableModels, setAvailableModels] = useState([])
  const [attachments, setAttachments] = useState([])  // array of {filename, originalName, size, kind}
  const [uploading, setUploading] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const fileInputRef = useRef(null)
  const [loading, setLoading] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const messagesEndRef = useRef(null)
  const stickToBottomRef = useRef(true)
  const messagesContainerRef = useRef(null)
  const inputRef = useRef(null)
  const abortControllerRef = useRef(null)
  const activeChatRequestRef = useRef(null)
  const streamGenerationRef = useRef(0)
  const sendStartingRef = useRef(false)
  const chatRunStateRef = useRef(null)
  const mobile = useIsMobile()
  useTheme()

  // Swipe to open/close sidebar
  const swipeStartX = useRef(null)
  useEffect(() => {
    const onTouchStart = e => { swipeStartX.current = e.touches[0].clientX }
    const onTouchEnd = e => {
      if (swipeStartX.current === null) return
      const dx = e.changedTouches[0].clientX - swipeStartX.current
      if (dx < -60 && mobileSidebar) setMobileSidebar(false)
      swipeStartX.current = null
    }
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [mobileSidebar])

  useEffect(() => {
    loadConversations().then(convos => {
      const firstActive = Array.isArray(convos)
        ? convos.find(conversation => !conversation.archived_at)
        : null

      if (firstActive) selectConvo(firstActive)
    })
    api.get('/api/chat/models/list')
      .then(m => setAvailableModels(m.map(x => x.name)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    // Nur mitscrollen, wenn der User unten "klebt" — hochscrollen bleibt ungestoert
    if (stickToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [messages, chatRun?.events?.length, chatRun?.phase])

  // Scroll-to-bottom button: show when scrolled up >200px from bottom
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = distFromBottom < 120
      setShowScrollBtn(distFromBottom > 200)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll() // initial check
    return () => el.removeEventListener('scroll', onScroll)
  }, [activeConvo])

  function scrollToBottom() {
    stickToBottomRef.current = true
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    if (!jumpMessageId || loading) return

    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(
        `message-${jumpMessageId}`
      )

      if (!target) return

      target.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })

      if (typeof target.animate === 'function') {
        target.animate(
          [
            { filter: 'brightness(1)' },
            { filter: 'brightness(1.35)' },
            { filter: 'brightness(1)' }
          ],
          {
            duration: 1400,
            easing: 'ease-out'
          }
        )
      }

      setJumpMessageId(null)
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [jumpMessageId, loading, messages])

  // Server-Puls: PM2-Apps, Disk, Load — alle 30s
  useEffect(() => {
    let alive = true
    const load = () => api.get('/api/system/status')
      .then(d => {
        if (!alive) return
        setSysStatus(d)
        setSysStatusUpdatedAt(Date.now())
      })
      .catch(() => {})
    load()
    const iv = setInterval(load, 30000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  function toggleMonitoredApp(name) {
    setMonitoredApps(current => {
      const next = current.includes(name) ? current.filter(item => item !== name) : [...current, name]
      localStorage.setItem('echolink.monitoredApps', JSON.stringify(next))
      return next
    })
  }

  async function loadConversations() {
    const convos = await api.get('/api/conversations?includeArchived=1')
    setConversations(convos)
    return convos
  }

  useEffect(() => {
    if (!activeConvo?.id) return

    let refreshing = false

    async function refreshChatAfterResume() {
      if (
        refreshing ||
        streaming ||
        document.visibilityState !== 'visible'
      ) {
        return
      }

      refreshing = true

      try {
        const conversationId = activeConvo.id

        const msgs = await api.get(
          `/api/conversations/${conversationId}/messages?refresh=${Date.now()}`
        )

        setMessages(msgs)

        const convos = await api.get(
          `/api/conversations?includeArchived=1&refresh=${Date.now()}`
        )

        if (Array.isArray(convos)) {
          setConversations(convos)
        }
      } catch (error) {
        console.error(
          'Chat refresh after resume failed:',
          error?.message || error
        )
      } finally {
        refreshing = false
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        refreshChatAfterResume()
      }
    }

    window.addEventListener(
      'focus',
      refreshChatAfterResume
    )

    window.addEventListener(
      'pageshow',
      refreshChatAfterResume
    )

    document.addEventListener(
      'visibilitychange',
      handleVisibilityChange
    )

    return () => {
      window.removeEventListener(
        'focus',
        refreshChatAfterResume
      )

      window.removeEventListener(
        'pageshow',
        refreshChatAfterResume
      )

      document.removeEventListener(
        'visibilitychange',
        handleVisibilityChange
      )
    }
  }, [activeConvo?.id, streaming])

  async function selectConvo(convo) {
    setActiveConvo(convo)
    setLoading(true)
    try {
      const msgs = await api.get(`/api/conversations/${convo.id}/messages`)
      setMessages(msgs)
    } finally {
      setLoading(false)
    }
  }

  async function openSearchResult(result) {
    const conversationId = Number(
      result?.conversationId
    )

    const messageId = Number(
      result?.messageId
    )

    if (
      !Number.isInteger(conversationId) ||
      conversationId <= 0 ||
      !Number.isInteger(messageId) ||
      messageId <= 0
    ) {
      return
    }

    let conversation = conversations.find(
      item => Number(item.id) === conversationId
    )

    if (!conversation) {
      const refreshed = await loadConversations()

      conversation = refreshed.find(
        item => Number(item.id) === conversationId
      )
    }

    if (!conversation) return

    stickToBottomRef.current = false
    await selectConvo(conversation)
    setJumpMessageId(messageId)
  }

  async function createConvo() {
    if (activeConvo) {
      try { await api.post(`/api/memory/update/${activeConvo.id}`, {}) } catch {}
    }
    const convo = await api.post('/api/conversations', {})
    setConversations(prev => [convo, ...prev])
    await selectConvo(convo)
  }

  async function deleteConvo(id) {
    await api.delete(`/api/conversations/${id}`)
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeConvo?.id === id) { setActiveConvo(null); setMessages([]) }
  }

  async function renameConvo(id, title) {
    const updated = await api.patch(`/api/conversations/${id}`, { title })
    setConversations(prev => prev.map(c => c.id === id ? updated : c))
    if (activeConvo?.id === id) setActiveConvo(updated)
  }

  async function archiveConvo(id) {
    await api.post(`/api/conversations/${id}/archive`, {})
    const convos = await loadConversations()

    if (activeConvo?.id === id) {
      const next = convos.find(
        conversation =>
          !conversation.archived_at &&
          conversation.id !== id
      )

      if (next) {
        await selectConvo(next)
      } else {
        setActiveConvo(null)
        setMessages([])
      }
    }
  }

  async function restoreConvo(id) {
    await api.post(`/api/conversations/${id}/restore`, {})
    const convos = await loadConversations()

    if (activeConvo?.id === id) {
      const restored = convos.find(
        conversation => conversation.id === id
      )
      if (restored) setActiveConvo(restored)
    }
  }

  function updateConvo(updated) {
    setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
    setActiveConvo(updated)
  }

  function cancelActiveChatRequest() {
    const activeRequest = activeChatRequestRef.current

    if (activeRequest) {
      fetch(
        `/api/chat/${activeRequest.conversationId}/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            requestId: activeRequest.requestId
          }),
          keepalive: true
        }
      ).catch(error => {
        console.warn(
          'Server-side chat cancellation failed:',
          error?.message || error
        )
      })
    }

    abortControllerRef.current?.abort()
  }

  function stopStreaming() {
    const chatRunState = chatRunStateRef.current

    if (chatRunState) {
      setChatRun(current =>
        chatRunState.requestChatRunCancel(current)
      )
    }

    cancelActiveChatRequest()
  }

  async function sendMessage(
    contentOverride,
    skipSave = false,
    resumeCheckpoints = []
  ) {
    const content = contentOverride
    const hasAttachments = attachments.length > 0
    if (
      (!content && !hasAttachments) ||
      !activeConvo ||
      sendStartingRef.current
    ) {
      return
    }

    sendStartingRef.current = true

    // Interrupt: stop the previous server run before starting a new one.
    if (streaming && abortControllerRef.current) {
      cancelActiveChatRequest()
    }
    const myGeneration = ++streamGenerationRef.current
    const attachmentsToSend = attachments
    setAttachments([])
    inputRef.current?.focus()

    const userId = `u_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const assistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const requestId =
      window.crypto?.randomUUID?.() ||
      `chat_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const conversationId = activeConvo.id

    let chatRunState

    try {
      chatRunState = await loadChatRunStateModule()
    } catch (error) {
      sendStartingRef.current = false
      console.error(
        'Chat run module failed to load:',
        error?.message || error
      )
      return
    }

    if (streamGenerationRef.current !== myGeneration) {
      sendStartingRef.current = false
      return
    }

    chatRunStateRef.current = chatRunState

    const baseChatRun = chatRunState.createChatRun({
      id: assistantId,
      content,
      checkpoints: resumeCheckpoints
    })

    let trackChatRun = chatRunState.shouldShowChatRun({
      content,
      attachments: attachmentsToSend
    })
    let chatRunSettled = false

    const updateTrackedChatRun = updater => {
      if (
        !trackChatRun ||
        streamGenerationRef.current !== myGeneration
      ) {
        return
      }

      setChatRun(current => updater(
        current?.id === assistantId
          ? current
          : baseChatRun
      ))
    }

    const ensureTrackedChatRun = updater => {
      trackChatRun = true
      updateTrackedChatRun(updater)
    }

    const completeTrackedChatRun = () => {
      if (!trackChatRun || chatRunSettled) return
      chatRunSettled = true
      updateTrackedChatRun(current =>
        chatRunState.finishChatRun(current)
      )
    }

    const cancelTrackedChatRun = () => {
      if (!trackChatRun || chatRunSettled) return
      chatRunSettled = true
      updateTrackedChatRun(current =>
        chatRunState.cancelChatRun(current)
      )
    }

    const failTrackedChatRun = error => {
      if (!trackChatRun || chatRunSettled) return
      chatRunSettled = true
      updateTrackedChatRun(current =>
        chatRunState.failChatRun(current, error)
      )
    }

    if (trackChatRun) {
      setChatRun(baseChatRun)
    } else {
      setChatRun(null)
    }

    setLunaLiveContext(
      createLunaLiveContext({
        assistantId,
        usage:
          lunaResolvedContext ||
          latestContextUsage,
        messages,
        content,
        attachments: attachmentsToSend,
        skipSave,
        model: activeConvo.model
      })
    )

    sendStartingRef.current = false

    setMessages(prev => [
      ...prev,
      // On regenerate (skipSave=true), don't add user message to UI again
      ...(skipSave ? [] : [{ id: userId, role: 'user', content, images: attachmentsToSend.length > 0 ? JSON.stringify(attachmentsToSend) : '' }]),
      { id: assistantId, role: 'assistant', content: '', streaming: true, actionRequests: [] }
    ])
    setStreaming(true)

    let assistantContent = ''

    abortControllerRef.current = new AbortController()
    activeChatRequestRef.current = {
      requestId,
      conversationId
    }

    // SSE stream with auto-reconnect (max 3 retries, exponential backoff)
    const endpoint = `/api/chat/${conversationId}`
    const maxRetries = 3
    let retryCount = 0

    const streamAttempt = async (isRetry) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          attachments: attachmentsToSend,
          skipSave: skipSave || isRetry,
          resumeCheckpoints,
          requestId
        }),
        signal: abortControllerRef.current.signal
      })

      if (!response.ok) {
        throw await readResponseError(response)
      }

      if (!response.body) {
        const error = new Error('Streaming-Antwort enthaelt keinen Body')
        error.retryable = true
        throw error
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let sseBuffer = ''

      const processEvent = rawEvent => {
        const json = parseSseEvent(rawEvent)
        if (!json) return

        if (json.checkpoint) {
          ensureTrackedChatRun(current =>
            chatRunState.addChatRunCheckpoint(
              current,
              json.checkpoint
            )
          )
        }
        if (json.tool) {
          const toolStatus = formatLunaToolEvent(json)

          ensureTrackedChatRun(current =>
            chatRunState.markChatRunTool(current, json)
          )

          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? { ...m, toolStatus }
              : m
          ))
        }
        if (json.token) {
          if (trackChatRun) {
            updateTrackedChatRun(current =>
              chatRunState.markChatRunWriting(current)
            )
          }

          assistantContent += json.token
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: assistantContent, toolStatus: null } : m
          ))
        }
        if (json.usage) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, usage: json.usage } : m
          ))
        }
        if (json.done) {
          completeTrackedChatRun()
          setLunaLiveContext(null)

          const normalized = json.tokens ? {
            prompt_tokens: json.tokens.promptTokens,
            completion_tokens: json.tokens.completionTokens,
            total_tokens: json.tokens.totalTokens
          } : null

          const contextUsage = json.context ? {
            context_budget_tokens:
              json.context.budgetTokens,
            context_estimated_input_tokens:
              json.context.estimatedInputTokens,
            context_kept_messages:
              json.context.keptMessages,
            context_omitted_messages:
              json.context.omittedMessages,
            context_over_budget:
              json.context.overBudget,
            context_model:
              json.context.model
          } : null

          const doneUsage = json.usage || null
          const resolvedBaseUsage =
            normalized ||
            doneUsage ||
            null
          const resolvedContextUsage =
            contextUsage
              ? {
                  ...(resolvedBaseUsage || {}),
                  ...contextUsage
                }
              : null

          if (resolvedContextUsage) {
            setLunaResolvedContext(
              resolvedContextUsage
            )
          }

          setMessages(prev => prev.map(m => {
            if (m.id !== assistantId) return m

            const baseUsage =
              resolvedBaseUsage ||
              m.usage ||
              null

            return {
              ...m,
              streaming: false,
              usage: contextUsage
                ? {
                    ...(baseUsage || {}),
                    ...contextUsage
                  }
                : baseUsage
            }
          }))
        }
        if (json.error) {
          throw new Error(json.error)
        }
        if (json.actionRequest) {
          ensureTrackedChatRun(current =>
            chatRunState.markChatRunWaitingApproval(
              current,
              json.description || json.reason || ''
            )
          )

          const action = {
            actionId: json.actionId,
            description: json.description,
            command: json.command,
            reason: json.reason,
            type: json.type,
            source: json.source
          }
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, actionRequests: [action] } : m
          ))
        }
      }

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          sseBuffer += decoder.decode()
          break
        }

        sseBuffer += decoder.decode(value, { stream: true })

        // Ein SSE-Event endet mit einer Leerzeile.
        const events = sseBuffer.split(/\r?\n\r?\n/)
        sseBuffer = events.pop() || ''

        for (const event of events) {
          processEvent(event)
        }
      }

      // Manche Server/Proxies schliessen den Stream ohne abschliessende Leerzeile.
      if (sseBuffer.trim()) {
        processEvent(sseBuffer)
      }
    }

    try {
      await streamAttempt(false)
      completeTrackedChatRun()
    } catch (err) {
      if (err.name === 'AbortError') {
        cancelTrackedChatRun()
        // Stopped by user — mark as done
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, streaming: false, content: assistantContent || '_(stopped)_' } : m
        ))
      } else if (err.retryable === false) {
        failTrackedChatRun(err)
        // Client-, Auth- oder Validierungsfehler werden durch einen Retry nicht besser.
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? {
            ...m,
            content: `Error: ${err.message}`,
            streaming: false,
            retryFailed: true
          } : m
        ))
      } else {
        // Netzwerk-, Rate-Limit- und Serverfehler duerfen erneut versucht werden.
        while (retryCount < maxRetries && streamGenerationRef.current === myGeneration) {
          retryCount++
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: assistantContent + `\n\n_Reconnecting… (${retryCount}/${maxRetries})_`, streaming: true } : m
          ))
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retryCount - 1)))
          if (streamGenerationRef.current !== myGeneration) break
          try {
            abortControllerRef.current = new AbortController()
            await streamAttempt(true)
            completeTrackedChatRun()
            // Reconnect succeeded — restore content without the reconnecting text
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: assistantContent, streaming: true } : m
            ))
            break
          } catch (retryErr) {
            if (retryErr.name === 'AbortError') {
              cancelTrackedChatRun()
              break
            }
            if (retryErr.retryable === false || retryCount >= maxRetries) {
              failTrackedChatRun(retryErr)
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? {
                  ...m,
                  content: `Connection error: ${retryErr.message || err.message}`,
                  streaming: false,
                  retryFailed: true
                } : m
              ))
              break
            }
          }
        }
      }
    } finally {
      // Skip cleanup if a newer stream has started (interrupt) —
      // the new sendMessage call handles streaming state and message reload
      if (streamGenerationRef.current !== myGeneration) return
      setStreaming(false)
      setLunaLiveContext(null)
      // Always clear per-message streaming flag — done event may not arrive
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, streaming: false } : m
      ))
      abortControllerRef.current = null
      if (
        activeChatRequestRef.current?.requestId ===
        requestId
      ) {
        activeChatRequestRef.current = null
      }
      loadConversations()
      // Reload messages from DB to replace temp string IDs with real integer IDs
      // (needed for delete/regenerate to work — temp IDs like "u_..." don't match DB rows)
      if (activeConvo) {
        try {
          const msgs = await api.get(`/api/conversations/${activeConvo.id}/messages`)
          setMessages(msgs)
        } catch {}
      }
      // Refocus input so user can keep typing without clicking
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  async function handleActionApprove(actionId, actionRequest) {
    try {
      const endpoint = '/api/chat/action/' + actionId + '/approve'
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      const chatRunState = chatRunStateRef.current
      if (chatRunState) {
        setChatRun(current =>
          chatRunState.markChatRunApproval(current, true)
        )
      }
    } catch (err) {
      console.error('Approve error:', err)
    }
  }

  async function handleActionAlways(actionId, actionRequest) {
    try {
      const words = (actionRequest?.command || '').trim().split(/\s+/)
      const bad = /[;&|><`$\\'"]/
      let prefix = words.slice(0, 2).join(' ')
      if (bad.test(prefix)) prefix = words[0] || ''
      if (prefix.length >= 3 && !bad.test(prefix)) {
        await api.post('/api/chat/allowlist', { prefix })
      }
    } catch (err) { console.error('Allowlist error:', err) }
    handleActionApprove(actionId, actionRequest)
  }

  async function handleActionDeny(actionId, actionRequest) {
    try {
      const endpoint = '/api/chat/action/' + actionId + '/deny'
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      const chatRunState = chatRunStateRef.current
      if (chatRunState) {
        setChatRun(current =>
          chatRunState.markChatRunApproval(current, false)
        )
      }
    } catch (err) {
      console.error('Deny error:', err)
    }
  }

  const deleteMessage = useCallback(async (msgId) => {
    try {
      await api.delete(`/api/conversations/message/${msgId}`)
      setMessages(prev => prev.filter(msg => msg.id !== msgId))
    } catch (err) {
      console.error('Delete message error:', err)
    }
  }, [])

  async function saveEdit(msgId, newContent) {
    if (!newContent.trim()) return
    try {
      const res = await api.put(`/api/conversations/message/${msgId}`, { content: newContent.trim() })
      // Update the edited message in UI and remove everything after it
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === msgId)
        if (idx === -1) return prev
        const updated = [...prev]
        updated[idx] = { ...updated[idx], content: newContent.trim() }
        return updated.slice(0, idx + 1)  // keep only up to edited message
      })
      setEditingId(null)
      // Regenerate assistant response
      await sendMessage(newContent.trim(), true)
    } catch (err) {
      console.error('Edit message error:', err)
      setEditingId(null)
    }
  }

  async function regenerate() {
    if (streaming || messages.length < 2) return
    // Find last user message
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    if (!lastUser) return
    // Remove last assistant message from UI
    setMessages(prev => {
      const idx = [...prev].reverse().findIndex(m => m.role === 'assistant')
      if (idx === -1) return prev
      const realIdx = prev.length - 1 - idx
      return prev.slice(0, realIdx)
    })
    // Remove last assistant message from DB
    try {
      await api.delete(`/api/conversations/${activeConvo.id}/last-assistant`)
    } catch {}
    await sendMessage(lastUser.content, true)
  }

  async function retryMessage(msgId) {
    if (streaming) return
    // Find the failed assistant message and the user message before it
    const idx = messages.findIndex(m => m.id === msgId)
    if (idx === -1) return
    const lastUser = [...messages.slice(0, idx)].reverse().find(m => m.role === 'user')
    if (!lastUser) return
    // Remove the failed assistant message from UI
    setMessages(prev => prev.filter(m => m.id !== msgId))
    // Remove last assistant message from DB
    try {
      await api.delete(`/api/conversations/${activeConvo.id}/last-assistant`)
    } catch {}
    // Reset streamGenerationRef so the new stream can proceed
    streamGenerationRef.current++
    await sendMessage(lastUser.content, true)
  }

  async function handleFileSelect(e) {
    const files = e.target.files
    if (!files || files.length === 0) return
    if (attachments.length + files.length > 5) {
      alert('Maximum 5 files per message')
      return
    }
    setUploading(true)
    try {
      const formData = new FormData()
      for (const f of files) formData.append('files', f)
      const res = await fetch('/api/uploads', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }))
        throw new Error(err.error || 'Upload failed')
      }
      const { files: uploaded } = await res.json()
      setAttachments(prev => [...prev, ...uploaded])
    } catch (err) {
      alert('Upload error: ' + err.message)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function removeAttachment(filename) {
    setAttachments(prev => prev.filter(a => a.filename !== filename))
  }

  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant')

  const monitoredProcessProblem =
    sysStatus?.apps
      ?.filter(app =>
        monitoredApps.includes(app.name)
      )
      .some(app => app.status !== 'online') ||
    false

  const databaseBackupAge =
    sysStatus?.backups?.database?.ageSeconds

  const fullBackupAge =
    sysStatus?.backups?.full?.ageSeconds

  const systemResourceProblem =
    Boolean(sysStatus) &&
    (
      Number(sysStatus?.memory?.usedPercent) >= 90 ||
      Number(sysStatus?.disk) >= 90 ||
      Number(sysStatus?.cpu) >= 95 ||
      !sysStatus?.backups?.database?.found ||
      Number(databaseBackupAge) > 172800 ||
      !sysStatus?.backups?.full?.found ||
      Number(fullBackupAge) > 1209600
    )

  const systemMood =
    monitoredProcessProblem ||
    systemResourceProblem
      ? 'panic'
      : streaming
        ? 'focus'
        : 'ok'

  const latestAssistant = [...messages]
    .reverse()
    .find(message => message.role === 'assistant')

  const latestUserForChatRun = [...messages]
    .reverse()
    .find(message => message.role === 'user')

  useEffect(() => {
    if (
      chatRun ||
      !streaming ||
      !latestAssistant?.streaming
    ) {
      return undefined
    }

    const content = latestUserForChatRun?.content || ''
    const hasToolStatus = Boolean(
      latestAssistant?.toolStatus
    )

    if (!content && !hasToolStatus) {
      return undefined
    }

    let alive = true

    loadChatRunStateModule()
      .then(module => {
        if (!alive) return

        const shouldRecover =
          hasToolStatus ||
          module.shouldShowChatRun({ content })

        if (!shouldRecover) return

        chatRunStateRef.current = module

        let recovered = module.createChatRun({
          id: latestAssistant.id,
          content
        })

        if (hasToolStatus) {
          recovered = {
            ...recovered,
            phase: 'running',
            currentStep: 1,
            progress: normalizeLunaToolStatus(
              latestAssistant.toolStatus
            ) || 'Werkzeug wird ausgeführt'
          }
        }

        setChatRun(current => current || recovered)
      })
      .catch(error => {
        console.error(
          'Chat run recovery failed:',
          error?.message || error
        )
      })

    return () => {
      alive = false
    }
  }, [
    chatRun,
    streaming,
    latestAssistant?.id,
    latestAssistant?.streaming,
    latestAssistant?.toolStatus,
    latestUserForChatRun?.content
  ])

  const latestContextUsage = [...messages]
    .reverse()
    .find(message =>
      message.role === 'assistant' &&
      Number(message.usage?.context_budget_tokens) > 0
    )?.usage

  const lunaHudUsage =
    lunaLiveContext &&
    latestAssistant?.id ===
      lunaLiveContext.assistantId
      ? {
          ...lunaLiveContext.usage,
          context_live_output_tokens:
            estimateLunaContextTokens(
              latestAssistant.content
            ) +
            estimateLunaContextTokens(
              latestAssistant.think
            )
        }
      : lunaResolvedContext ||
        latestContextUsage

  const lunaHudModel =
    lunaHudUsage?.context_model ||
    activeConvo?.model ||
    ''

  const latestToolDetail =
    normalizeLunaToolStatus(
      latestAssistant?.toolStatus
    )

  const latestToolText =
    getLunaToolText(latestAssistant?.toolStatus)

  const latestToolKind =
    getLunaToolKind(latestAssistant?.toolStatus)

  const waitingForApproval =
    Array.isArray(latestAssistant?.actionRequests) &&
    latestAssistant.actionRequests.length > 0

  const lunaPresence =
    systemMood === 'panic'
      ? {
          tone: 'danger',
          kind: 'alert',
          text: 'Luna meldet: System braucht Aufmerksamkeit'
        }
      : waitingForApproval
        ? {
            tone: 'waiting',
            kind: 'approval',
            text: 'Luna wartet auf deine Freigabe'
          }
        : streaming && latestToolText
          ? {
              tone: 'active',
              kind: latestToolKind || 'tool',
              text: latestToolText
            }
          : streaming
            ? {
                tone: 'active',
                kind:
                  latestAssistant?.think &&
                  !latestAssistant?.content
                    ? 'thought'
                    : 'speech',
                text:
                  latestAssistant?.think &&
                  !latestAssistant?.content
                    ? 'Luna denkt …'
                    : 'Luna spricht …'
              }
            : latestAssistant?.retryFailed
              ? {
                  tone: 'danger',
                  kind: 'alert',
                  text: 'Luna ist über einen Fehler gestolpert'
                }
              : showLunaDone
                ? {
                    tone: 'success',
                    kind: 'success',
                    text: 'Alles erledigt'
                  }
                : null

  const lunaFinishedCleanly =
    showLunaDone &&
    !latestAssistant?.retryFailed

  const lunaFaceMood =
    systemMood === 'panic'
      ? 'panic'
      : streaming
        ? 'focus'
        : lunaFinishedCleanly
          ? 'wink'
          : lunaIdle
            ? 'sleepy'
            : 'ok'

  const lunaActivity =
    streaming && latestToolKind
      ? latestToolKind
      : ''

  const lunaPresenceSymbol =
    getLunaPresenceSymbol(lunaPresence?.kind)

  const lunaSurfaceClass = [
    'luna-chat-surface',
    lunaPresence
      ? `luna-chat-${lunaPresence.tone}`
      : '',
    !lunaPresence && lunaIdle
      ? 'luna-chat-idle'
      : ''
  ].filter(Boolean).join(' ')

  return (
    <div style={styles.root}>
      {(!mobile || mobileSidebar) && (
        <Sidebar
          conversations={conversations}
          activeId={activeConvo?.id}
          onSelect={selectConvo}
          onCreate={createConvo}
          onDelete={deleteConvo}
          onRename={renameConvo}
          onArchive={archiveConvo}
          onRestore={restoreConvo}
          onSearchResult={openSearchResult}
          user={user}
          onLogout={onLogout}
          mobileOpen={mobileSidebar}
          onMobileClose={() => setMobileSidebar(false)}
          mobile={mobile}
        />
      )}

      <main style={styles.main}>
        <div style={{
          ...styles.topbar,
          ...(mobile
            ? {
                gap: 8,
                padding: '0 10px'
              }
            : {})
        }}>
          <button style={styles.menuBtn} onClick={() => setMobileSidebar(v => !v)}>
            <MenuIcon />
          </button>
          <span style={{
            ...styles.convoTitle,
            ...(mobile
              ? {
                  flex: '1 1 auto',
                  minWidth: 0,
                  maxWidth: 110
                }
              : {})
          }}>
            {activeConvo ? activeConvo.title : 'EchoLink'}
          </span>
          {sysStatus && (
            mobile ? (
              <>
                <button
                  ref={lunaButtonRef}
                  type="button"
                  onClick={() => {
                    setShowTools(false)
                    setShowLunaHud(open => !open)
                  }}
                  title="Luna Mini-HUD"
                  aria-label="Luna Mini-HUD"
                  aria-expanded={showLunaHud}
                  aria-controls="luna-mini-hud"
                  style={{
                    ...styles.systemFaceCenter,
                    color:
                      systemMood === 'panic'
                        ? 'var(--danger)'
                        : 'var(--text2)'
                  }}
                >
                  <CorsnFace
                    mood={lunaFaceMood}
                    activity={lunaActivity}
                  />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowLunaHud(false)
                    setShowSysPanel(true)
                  }}
                  title="Systemstatus"
                  aria-label="Systemstatus"
                  style={styles.systemDotsRight}
                >
                  <span style={styles.systemDots}>
                    {sysStatus.apps
                      .filter(app =>
                        monitoredApps.includes(
                          app.name
                        )
                      )
                      .map(app => (
                        <span
                          key={app.name}
                          style={{
                            ...styles.systemDot,
                            background:
                              app.status === 'online'
                                ? 'var(--accent)'
                                : 'var(--danger)'
                          }}
                        />
                      ))}
                  </span>
                </button>
              </>
            ) : (
              <div style={styles.systemDesktop}>
                <button
                  ref={lunaButtonRef}
                  type="button"
                  onClick={() => {
                    setShowTools(false)
                    setShowLunaHud(open => !open)
                  }}
                  title="Luna Mini-HUD"
                  aria-label="Luna Mini-HUD"
                  aria-expanded={showLunaHud}
                  aria-controls="luna-mini-hud"
                  style={{
                    ...styles.systemDesktopFace,
                    color:
                      systemMood === 'panic'
                        ? 'var(--danger)'
                        : 'var(--text2)'
                  }}
                >
                  <CorsnFace
                    mood={lunaFaceMood}
                    activity={lunaActivity}
                  />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowLunaHud(false)
                    setShowSysPanel(true)
                  }}
                  title="Systemstatus"
                  aria-label="Systemstatus"
                  style={styles.systemDesktopDots}
                >
                  <span style={styles.systemDots}>
                    {sysStatus.apps
                      .filter(app =>
                        monitoredApps.includes(
                          app.name
                        )
                      )
                      .map(app => (
                        <span
                          key={app.name}
                          style={{
                            ...styles.systemDot,
                            background:
                              app.status === 'online'
                                ? 'var(--accent)'
                                : 'var(--danger)'
                          }}
                        />
                      ))}
                  </span>
                </button>
              </div>
            )
          )}

          {showLunaHud && sysStatus && (
            <LunaMiniHud
              containerRef={lunaHudRef}
              model={lunaHudModel}
              requestedModel={activeConvo?.model || ''}
              usage={lunaHudUsage}
              toolText={latestToolText}
              toolDetail={latestToolDetail}
              toolActive={streaming && Boolean(latestToolText)}
              waitingForApproval={waitingForApproval}
              streaming={streaming}
              systemMood={systemMood}
              status={sysStatus}
              statusUpdatedAt={sysStatusUpdatedAt}
              mobile={mobile}
              onOpenSystem={() => {
                setShowLunaHud(false)
                setShowSysPanel(true)
              }}
              onClose={() => setShowLunaHud(false)}
            />
          )}
<button
            type="button"
            onClick={() => setShowTools(true)}
            title="Werkzeuge und Einstellungen"
            aria-label="Werkzeuge und Einstellungen"
            style={{
              ...styles.settingsBtn,
              ...(mobile
                ? styles.mobileToolsButton
                : {}),

              color: showTools
                ? 'var(--accent)'
                : 'var(--text2)'
            }}
          >
            <MoreIcon />
          </button>
        </div>

        <div
          className={lunaSurfaceClass}
          style={styles.messages}
          ref={messagesContainerRef}
        >
          {!activeConvo && (
            <div style={styles.empty} className="fade-in">
              <div style={styles.emptyLogo}>
                <svg width="48" height="48" viewBox="0 0 32 32" fill="none">
                  <rect width="32" height="32" rx="8" fill="var(--accent)"/>
                  <path d="M8 22 L14 10 L20 18 L24 14" stroke="#0d0d0d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="24" cy="14" r="2" fill="#0d0d0d"/>
                </svg>
              </div>
              <h2 style={styles.emptyTitle}>Echo<span style={{ color:'var(--green)' }}>Link</span></h2>
              <p style={styles.emptySub}>Select a conversation or create a new one.</p>
              <button style={styles.emptyBtn} onClick={createConvo}>+ New Conversation</button>
            </div>
          )}

          {activeConvo && loading && (
            <div style={{ display:'flex', justifyContent:'center', paddingTop: 40 }}>
              <div style={{ width:20, height:20, border:'2px solid var(--green)', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
            </div>
          )}

          {activeConvo && !loading && (() => {
            // Aufeinanderfolgende Terminal-Messages zu einer Timeline gruppieren
            const isTerm = (x) => x.role === 'assistant' && !x.streaming
              && typeof x.content === 'string' && x.content.startsWith('**Terminal:** ')
            const out = []
            for (let i = 0; i < messages.length; i++) {
              const m = messages[i]
              if (isTerm(m)) {
                const group = [m]
                while (i + 1 < messages.length && isTerm(messages[i + 1])) group.push(messages[++i])
                out.push(
                  <div
                    key={'tg-' + group[0].id}
                    style={{
                      position: 'relative',
                      scrollMarginTop: 80
                    }}
                  >
                    {group.map(item => (
                      <span
                        key={`anchor-${item.id}`}
                        id={`message-${item.id}`}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: 1,
                          height: 1,
                          pointerEvents: 'none'
                        }}
                      />
                    ))}
                    <TerminalTimeline
                      items={group}
                      onDelete={deleteMessage}
                    />
                  </div>
                )
              } else {
                const prev = out.length === 0 ? null : messages[i - 1]
                out.push(
            <Message
              key={m.id}
              role={m.role}
              content={m.content}
              streaming={m.streaming}
              images={m.images}
              think={m.think}
              toolStatus={m.toolStatus}
              actionRequests={m.actionRequests}
              usage={m.usage}
              id={m.id}
              createdAt={m.created_at}
              prevCreatedAt={prev ? prev.created_at : null}
              onDelete={deleteMessage}
              onApprove={handleActionApprove}
              onAlwaysAllow={handleActionAlways}
              onDeny={handleActionDeny}
              editing={editingId === m.id}
              onEdit={() => setEditingId(m.id)}
              onSaveEdit={saveEdit}
              onCancelEdit={() => setEditingId(null)}
              retryFailed={m.retryFailed}
              onRetry={retryMessage}
            />
                )
              }
            }
            return out
          })()}

          {activeConvo && !loading && messages.length === 0 && (
            <div style={styles.emptyChat}><p>Start the conversation below.</p></div>
          )}

          {showScrollBtn && (
            <button
              onClick={scrollToBottom}
              style={{
                position: 'fixed', left: 8, bottom: 150,
                width: 44, height: 44, minWidth: 44, minHeight: 44, borderRadius: '50%',
                background: 'var(--bg2)', border: '1px solid var(--border)',
                color: 'var(--text2)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                zIndex: 10, flexShrink: 0
              }}
              title="Scroll to bottom"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
          )}

          <div ref={messagesEndRef} />
        </div>

        {activeConvo && !streaming && messages.length > 0 && (
          <div
            className="echolink-quick-chips"
            aria-label="Schnellbefehle"
          >
            {[
              ['PM2', 'pm2 status'],
              ['Speicher', 'df -h'],
              ['Error-Logs', 'zeig die letzten error-logs']
            ].map(([label, prompt]) => (
              <button
                key={prompt}
                type="button"
                className="echolink-quick-chip"
                onClick={() => sendMessage(prompt)}
                title={prompt}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {chatRun && (
          <Suspense
            fallback={
              <div
                style={{
                  flexShrink: 0,
                  margin: '6px 12px 4px',
                  color: 'var(--text3)',
                  fontSize: 11
                }}
              >
                Chat-Ablauf wird geladen …
              </div>
            }
          >
            <ChatAgentCockpit
              run={chatRun}
              streaming={streaming}
              mobile={mobile}
              onCancel={stopStreaming}
              onResume={checkpoints =>
                sendMessage(
                  chatRun?.requestContent ||
                    latestUserForChatRun?.content ||
                    '',
                  true,
                  checkpoints
                )
              }
              onDismiss={() => setChatRun(null)}
            />
          </Suspense>
        )}

        {lunaPresence && (
          <div
            className={
              `luna-presence luna-presence-${lunaPresence.tone}`
            }
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span
              className="luna-presence-glyph"
              aria-hidden="true"
            >
              {lunaPresenceSymbol}
            </span>
            <span className="luna-presence-text">
              {lunaPresence.text}
            </span>
          </div>
        )}

        {activeConvo && (
          <MessageInput
            streaming={streaming}
            attachments={attachments}
            uploading={uploading}
            onSend={(content) => sendMessage(content)}
            onStop={stopStreaming}
            onRegenerate={regenerate}
            onFileSelect={handleFileSelect}
            onRemoveAttachment={removeAttachment}
            showRegenerate={!streaming && !!lastAssistantMsg && messages.length >= 2}
            inputRef={inputRef}
          />
        )}
      </main>

      {showTools && (
        <AppToolsMenu
          activeConversation={activeConvo}
          systemProblem={
            monitoredProcessProblem ||
            systemResourceProblem
          }
          onOpenShift={() => {
            setShowTools(false)
            setShowShiftImporter(true)
            setShowTasks(false)
            setShowMemory(false)
            setShowSettings(false)
          }}
          onOpenTasks={() => {
            setShowTools(false)
            setShowTasks(true)
            setShowShiftImporter(false)
            setShowMemory(false)
            setShowSettings(false)
          }}
          onOpenMemory={() => {
            setShowTools(false)
            setShowMemory(true)
            setShowTasks(false)
            setShowShiftImporter(false)
            setShowSettings(false)
          }}
          onOpenSystem={() => {
            setShowTools(false)
            setShowLunaHud(false)
            setShowSysPanel(true)
          }}
          onOpenSettings={() => {
            setShowTools(false)
            setShowSettings(true)
            setShowTasks(false)
            setShowMemory(false)
            setShowShiftImporter(false)
          }}
          onClose={() => setShowTools(false)}
        />
      )}

      {showSysPanel && sysStatus && (
        <ToolPanelErrorBoundary
          label="Systemstatus"
          onClose={() => setShowSysPanel(false)}
        >
          <Suspense
            fallback={
              <ToolPanelFallback label="Systemstatus" />
            }
          >
            <SystemStatusPanel
              status={sysStatus}
              monitoredApps={monitoredApps}
              onToggleApp={toggleMonitoredApp}
              onClose={() => setShowSysPanel(false)}
            />
          </Suspense>
        </ToolPanelErrorBoundary>
      )}

      {showShiftImporter && (
        <ToolPanelErrorBoundary
          label="Schichtplan"
          onClose={() => setShowShiftImporter(false)}
        >
          <Suspense
            fallback={
              <ToolPanelFallback label="Schichtplan" />
            }
          >
            <ShiftImporter
              onClose={() =>
                setShowShiftImporter(false)
              }
            />
          </Suspense>
        </ToolPanelErrorBoundary>
      )}

      {showTasks && (
        <ToolPanelErrorBoundary
          label="Aufgaben"
          onClose={() => setShowTasks(false)}
        >
          <Suspense
            fallback={
              <ToolPanelFallback label="Aufgaben" />
            }
          >
            <TaskPanel
              conversationId={activeConvo?.id || null}
              conversations={conversations}
              onConversationsChanged={loadConversations}
              onClose={() => setShowTasks(false)}
            />
          </Suspense>
        </ToolPanelErrorBoundary>
      )}

      {showMemory && activeConvo && (
        <ToolPanelErrorBoundary
          label="Memory"
          onClose={() => setShowMemory(false)}
        >
          <Suspense
            fallback={
              <ToolPanelFallback label="Memory" />
            }
          >
            <MemoryPanel
              conversationId={activeConvo.id}
              streaming={streaming}
              onClose={() => setShowMemory(false)}
            />
          </Suspense>
        </ToolPanelErrorBoundary>
      )}

      {showSettings && activeConvo && (
        <ToolPanelErrorBoundary
          label="Einstellungen"
          onClose={() => setShowSettings(false)}
        >
          <Suspense
            fallback={
              <ToolPanelFallback label="Einstellungen" />
            }
          >
            <SettingsPanel
              conversation={activeConvo}
              onUpdate={updateConvo}
              onClose={() => setShowSettings(false)}
            />
          </Suspense>
        </ToolPanelErrorBoundary>
      )}
    </div>
  )
}

const MenuIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
  </svg>
)
const MoreIcon = () => (
  <svg
    width="21"
    height="21"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
)

const CalendarImportIcon = () => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="17" rx="2" />
    <path d="M8 2v4M16 2v4M3 9h18" />
    <path d="M12 13v5M9.5 15.5 12 18l2.5-2.5" />
  </svg>
)

const ClockIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5l3.5 2" />
    <path d="M7 3.8 4.5 6.3M17 3.8l2.5 2.5" />
  </svg>
)

const BrainIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9.5 4.5A3 3 0 0 0 4 6v1.2A3.5 3.5 0 0 0 3 13a3.5 3.5 0 0 0 4 5.8A3 3 0 0 0 12 17V7.5a3 3 0 0 0-2.5-3z" />
    <path d="M14.5 4.5A3 3 0 0 1 20 6v1.2a3.5 3.5 0 0 1 1 5.8 3.5 3.5 0 0 1-4 5.8A3 3 0 0 1 12 17V7.5a3 3 0 0 1 2.5-3z" />
    <path d="M8 9h1.5M14.5 9H16M8 14h1.5M14.5 14H16" />
  </svg>
)

const GearIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
)

const styles = {
  root: { display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 },
  systemFaceCenter: {
    position: 'absolute',
    zIndex: 2,
    left: '50%',
    top: '50%',
    width: 44,
    height: 44,
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    border: 0,
    borderRadius: 0,
    background: 'transparent',
    transform: 'translate(-50%, -50%)'
  },
  systemDotsRight: {
    position: 'absolute',
    zIndex: 2,
    left: 'calc(50% + 20px)',
    top: '50%',
    width: 'auto',
    height: 40,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: 0,
    border: 0,
    background: 'transparent',
    color: 'var(--text2)',
    transform: 'translateY(-50%)'
  },
  mobileToolsButton: {
    position: 'absolute',
    zIndex: 3,
    right: 8,
    top: '50%',
    margin: 0,
    transform: 'translateY(-50%)'
  },
  systemDesktop: {
    height: 42,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'stretch',
    overflow: 'hidden',
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--bg3)'
  },
  systemDesktopFace: {
    width: 42,
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    background: 'transparent'
  },
  systemDesktopDots: {
    minWidth: 34,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 9px 0 7px',
    borderLeft: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text2)'
  },
  systemDots: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 5
  },
  systemDot: {
    width: 7,
    height: 7,
    borderRadius: '50%'
  },
  topbar: {
    position: 'relative',
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '0 16px', height: 54, flexShrink: 0,
    borderBottom: '1px solid var(--border)', background: 'var(--bg2)'
  },
  menuBtn: { color: 'var(--text2)', display: 'flex', alignItems: 'center', flexShrink: 0 },
  convoTitle: {
    flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)'
  },
  settingsBtn: { color: 'var(--text2)', display: 'flex', alignItems: 'center', flexShrink: 0 },
  messages: {
    flex: 1, overflowY: 'auto', overflowX: 'hidden',
    padding: '24px 20px', display: 'flex', flexDirection: 'column',
  },
  empty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', textAlign: 'center',
    gap: 14, paddingBottom: 60
  },
  emptyLogo: { marginBottom: 4 },
  emptyTitle: { fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 700 },
  emptySub: { color: 'var(--text2)', fontSize: 15 },
  emptyBtn: {
    marginTop: 8, padding: '12px 24px', borderRadius: 10,
    background: 'var(--accent)', color: 'var(--user-text, #0d0d0d)', fontWeight: 600,
    fontSize: 15, cursor: 'pointer', border: 'none', fontFamily: 'var(--font-sans)'
  },
  emptyChat: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 14 },
}
