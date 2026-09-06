function formatSourceDate(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  try {
    return new Intl.DateTimeFormat('de-AT', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(seconds * 1000))
  } catch {
    return ''
  }
}

export default function ChatHistorySources({ sources, onOpen }) {
  if (!Array.isArray(sources) || sources.length === 0) return null

  return (
    <aside className="chat-history-sources" aria-label="Frühere Chats">
      <div className="chat-history-sources-title">Frühere Chats</div>
      <div className="chat-history-sources-list">
        {sources.map(source => {
          const unavailable = source?.status === 'unavailable'
          const changed = source?.status === 'changed'
          const date = formatSourceDate(source?.createdAt)
          const title = source?.title || `Chat ${source?.conversationId || ''}`
          return (
            <div
              className="chat-history-source"
              key={`${source?.label || 'H'}-${source?.conversationId}-${source?.messageId}`}
            >
              <div className="chat-history-source-copy">
                <div className="chat-history-source-name">
                  <span className="chat-history-source-label">[{source?.label}]</span>
                  <span>{title}</span>
                  {source?.archived ? <span className="chat-history-source-badge">archiviert</span> : null}
                </div>
                <div className="chat-history-source-meta">
                  {date ? <span>{date}</span> : null}
                  {changed ? <span>Quelle wurde seit der Antwort geändert</span> : null}
                  {unavailable ? <span>Quelle nicht mehr verfügbar</span> : null}
                </div>
              </div>
              <button
                type="button"
                className="chat-history-source-open"
                disabled={unavailable}
                onClick={() => onOpen?.({
                  conversationId: source.conversationId,
                  messageId: source.messageId
                })}
              >
                Nachricht öffnen
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
