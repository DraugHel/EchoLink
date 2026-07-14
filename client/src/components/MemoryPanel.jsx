import {
  useEffect,
  useMemo,
  useState
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import api from '../lib/api.js'

const TYPE_OPTIONS = [
  ['profile', 'Profil'],
  ['preference', 'Präferenz'],
  ['project', 'Projekt'],
  ['instruction', 'Anweisung'],
  ['episodic', 'Episodisch'],
  ['temporary', 'Temporär'],
  ['persona', 'Persona'],
  ['fact', 'Fakt']
]

const TYPE_LABELS =
  Object.fromEntries(TYPE_OPTIONS)

const STATUS_LABELS = {
  active: 'Aktiv',
  archived: 'Archiviert',
  superseded: 'Ersetzt'
}

const emptyItem = {
  type: 'fact',
  scope: 'global',
  content: '',
  importance: 50,
  confidence: 1,
  expiresAt: ''
}

function buttonStyle({
  accent = false,
  danger = false,
  disabled = false
} = {}) {
  let background = 'var(--bg3)'
  let color = 'var(--text2)'
  let border = '1px solid var(--border)'

  if (accent) {
    background = 'var(--accent)'
    color = 'var(--user-text, #0d0d0d)'
    border = '1px solid transparent'
  }

  if (danger) {
    background = 'transparent'
    color = 'var(--danger)'
    border = '1px solid var(--danger)'
  }

  return {
    minHeight: 34,
    padding: '7px 11px',
    border,
    borderRadius: 8,
    background,
    color,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: accent ? 700 : 500,
    cursor: disabled
      ? 'not-allowed'
      : 'pointer',
    opacity: disabled ? 0.5 : 1
  }
}

function fieldStyle() {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '9px 10px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    outline: 'none',
    background: 'var(--bg3)',
    color: 'var(--text1)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12
  }
}

function dateText(timestamp) {
  if (!timestamp) return null

  return new Date(
    timestamp * 1000
  ).toLocaleString('de-AT', {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

function ItemEditor({
  value,
  onChange,
  onSave,
  onCancel,
  saving,
  saveLabel = 'Speichern'
}) {
  function set(name, nextValue) {
    onChange({
      ...value,
      [name]: nextValue
    })
  }

  return (
    <div
      style={{
        display: 'grid',
        gap: 10
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10
        }}
      >
        <label>
          <div style={labelStyle()}>
            Typ
          </div>

          <select
            value={value.type}
            onChange={event =>
              set('type', event.target.value)
            }
            style={fieldStyle()}
          >
            {TYPE_OPTIONS.map(
              ([key, label]) => (
                <option
                  key={key}
                  value={key}
                >
                  {label}
                </option>
              )
            )}
          </select>
        </label>

        <label>
          <div style={labelStyle()}>
            Scope
          </div>

          <input
            value={value.scope}
            onChange={event =>
              set('scope', event.target.value)
            }
            placeholder="global oder project:echolink"
            style={fieldStyle()}
          />
        </label>
      </div>

      <label>
        <div style={labelStyle()}>
          Inhalt
        </div>

        <textarea
          value={value.content}
          onChange={event =>
            set('content', event.target.value)
          }
          rows={5}
          placeholder="Eine klare, eigenständige Information …"
          style={{
            ...fieldStyle(),
            resize: 'vertical',
            lineHeight: 1.55
          }}
        />
      </label>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10
        }}
      >
        <label>
          <div style={labelStyle()}>
            Wichtigkeit: {value.importance}
          </div>

          <input
            type="range"
            min="0"
            max="100"
            value={value.importance}
            onChange={event =>
              set(
                'importance',
                Number(event.target.value)
              )
            }
            style={{ width: '100%' }}
          />
        </label>

        <label>
          <div style={labelStyle()}>
            Sicherheit: {
              Number(value.confidence)
                .toFixed(2)
            }
          </div>

          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={value.confidence}
            onChange={event =>
              set(
                'confidence',
                Number(event.target.value)
              )
            }
            style={{ width: '100%' }}
          />
        </label>

        <label>
          <div style={labelStyle()}>
            Ablaufdatum
          </div>

          <input
            type="datetime-local"
            value={value.expiresAt || ''}
            onChange={event =>
              set(
                'expiresAt',
                event.target.value
              )
            }
            style={fieldStyle()}
          />
        </label>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={buttonStyle({
            disabled: saving
          })}
        >
          Abbrechen
        </button>

        <button
          type="button"
          onClick={onSave}
          disabled={
            saving ||
            !value.content.trim()
          }
          style={buttonStyle({
            accent: true,
            disabled:
              saving ||
              !value.content.trim()
          })}
        >
          {saving
            ? 'Speichere …'
            : saveLabel}
        </button>
      </div>
    </div>
  )
}

function labelStyle() {
  return {
    marginBottom: 5,
    color: 'var(--text3)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.06em'
  }
}

export default function MemoryPanel({
  conversationId,
  streaming,
  onClose
}) {
  const [tab, setTab] =
    useState('items')

  const [items, setItems] =
    useState([])

  const [itemFilter, setItemFilter] =
    useState('active')

  const [itemsLoading, setItemsLoading] =
    useState(true)

  const [itemError, setItemError] =
    useState('')

  const [creating, setCreating] =
    useState(false)

  const [createDraft, setCreateDraft] =
    useState(emptyItem)

  const [editingId, setEditingId] =
    useState(null)

  const [editDraft, setEditDraft] =
    useState(null)

  const [actionId, setActionId] =
    useState(null)

  const [memory, setMemory] =
    useState('')

  const [legacyLoading, setLegacyLoading] =
    useState(true)

  const [legacyUpdating, setLegacyUpdating] =
    useState(false)

  const [legacyEditing, setLegacyEditing] =
    useState(false)

  const [legacyDraft, setLegacyDraft] =
    useState('')

  const [legacySaving, setLegacySaving] =
    useState(false)

  const [legacyDeleting, setLegacyDeleting] =
    useState(false)

  const [legacyError, setLegacyError] =
    useState('')

  async function loadItems() {
    setItemsLoading(true)
    setItemError('')

    try {
      const data = await api.get(
        `/api/memory/items?status=${encodeURIComponent(
          itemFilter
        )}&limit=200`
      )

      setItems(
        Array.isArray(data?.items)
          ? data.items
          : []
      )
    } catch (error) {
      setItemError(
        error?.message ||
        'Memories konnten nicht geladen werden.'
      )
    } finally {
      setItemsLoading(false)
    }
  }

  async function loadLegacy() {
    setLegacyLoading(true)
    setLegacyError('')

    try {
      const data =
        await api.get('/api/memory')

      const nextMemory =
        data?.memory || ''

      setMemory(nextMemory)

      if (!legacyEditing) {
        setLegacyDraft(nextMemory)
      }
    } catch (error) {
      setLegacyError(
        error?.message ||
        'Legacy-Memory konnte nicht geladen werden.'
      )
    } finally {
      setLegacyLoading(false)
    }
  }

  useEffect(() => {
    loadLegacy()
  }, [])

  useEffect(() => {
    loadItems()
  }, [itemFilter])

  const visibleItems =
    useMemo(
      () =>
        items.filter(
          item =>
            item.type !== 'legacy'
        ),
      [items]
    )

  async function createItem() {
    setActionId('create')
    setItemError('')

    try {
      await api.post(
        '/api/memory/items',
        {
          ...createDraft,
          expiresAt:
            createDraft.expiresAt ||
            null
        }
      )

      setCreateDraft(emptyItem)
      setCreating(false)
      await loadItems()
    } catch (error) {
      setItemError(
        error?.message ||
        'Memory konnte nicht erstellt werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  function beginEdit(item) {
    setEditingId(item.id)

    setEditDraft({
      type: item.type,
      scope: item.scope,
      content: item.content,
      importance: item.importance,
      confidence: item.confidence,
      expiresAt:
        item.expiresAt
          ? new Date(
              item.expiresAt * 1000
            )
              .toISOString()
              .slice(0, 16)
          : ''
    })
  }

  async function saveItem(itemId) {
    setActionId(itemId)
    setItemError('')

    try {
      await api.patch(
        `/api/memory/items/${itemId}`,
        {
          ...editDraft,
          expiresAt:
            editDraft.expiresAt ||
            null
        }
      )

      setEditingId(null)
      setEditDraft(null)
      await loadItems()
    } catch (error) {
      setItemError(
        error?.message ||
        'Memory konnte nicht gespeichert werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function confirmItem(itemId) {
    setActionId(itemId)

    try {
      await api.patch(
        `/api/memory/items/${itemId}`,
        {
          confirm: true
        }
      )

      await loadItems()
    } catch (error) {
      setItemError(
        error?.message ||
        'Memory konnte nicht bestätigt werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function archiveItem(itemId) {
    setActionId(itemId)

    try {
      await api.post(
        `/api/memory/items/${itemId}/archive`,
        {}
      )

      await loadItems()
    } catch (error) {
      setItemError(
        error?.message ||
        'Memory konnte nicht archiviert werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function restoreItem(itemId) {
    setActionId(itemId)

    try {
      await api.patch(
        `/api/memory/items/${itemId}`,
        {
          status: 'active'
        }
      )

      await loadItems()
    } catch (error) {
      setItemError(
        error?.message ||
        'Memory konnte nicht wiederhergestellt werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function deleteItem(item) {
    const confirmed =
      window.confirm(
        `Memory wirklich löschen?\n\n${item.content}`
      )

    if (!confirmed) return

    setActionId(item.id)

    try {
      await api.delete(
        `/api/memory/items/${item.id}`
      )

      await loadItems()
    } catch (error) {
      setItemError(
        error?.message ||
        'Memory konnte nicht gelöscht werden.'
      )
    } finally {
      setActionId(null)
    }
  }

  async function updateLegacy() {
    if (!conversationId || streaming) {
      return
    }

    setLegacyUpdating(true)
    setLegacyError('')

    try {
      const data = await api.post(
        `/api/memory/update/${conversationId}`,
        {}
      )

      if (
        typeof data?.memory ===
        'string'
      ) {
        setMemory(data.memory)
        setLegacyDraft(data.memory)
      } else {
        await loadLegacy()
      }
    } catch (error) {
      setLegacyError(
        error?.message ||
        'Legacy-Memory konnte nicht aktualisiert werden.'
      )
    } finally {
      setLegacyUpdating(false)
    }
  }

  async function saveLegacy() {
    setLegacySaving(true)
    setLegacyError('')

    try {
      const data = await api.post(
        '/api/memory/save',
        {
          content: legacyDraft
        }
      )

      setMemory(
        typeof data?.memory === 'string'
          ? data.memory
          : legacyDraft
      )

      setLegacyEditing(false)
    } catch (error) {
      setLegacyError(
        error?.message ||
        'Legacy-Memory konnte nicht gespeichert werden.'
      )
    } finally {
      setLegacySaving(false)
    }
  }

  async function clearLegacy() {
    const confirmed =
      window.confirm(
        'Das gesamte Legacy-Memory wirklich löschen?'
      )

    if (!confirmed) return

    setLegacyDeleting(true)

    try {
      await api.delete('/api/memory')
      setMemory('')
      setLegacyDraft('')
      setLegacyEditing(false)
    } catch (error) {
      setLegacyError(
        error?.message ||
        'Legacy-Memory konnte nicht gelöscht werden.'
      )
    } finally {
      setLegacyDeleting(false)
    }
  }

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
        onClick={event =>
          event.stopPropagation()
        }
        style={{
          width: 'min(820px, 100%)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border:
            '1px solid var(--border)',
          borderRadius: 14,
          background: 'var(--bg2)',
          boxShadow:
            '0 20px 60px rgba(0,0,0,0.55)'
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '13px 15px',
            borderBottom:
              '1px solid var(--border)'
          }}
        >
          <div style={{ flex: 1 }}>
            <strong
              style={{
                color: 'var(--text1)',
                fontFamily:
                  'var(--font-mono)'
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
              Strukturierte Erinnerungen mit
              Scope, Quelle und Gültigkeit
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            style={{
              ...buttonStyle(),
              width: 34,
              padding: 0,
              fontSize: 20
            }}
          >
            ×
          </button>
        </header>

        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '10px 15px',
            borderBottom:
              '1px solid var(--border)'
          }}
        >
          {[
            ['items', 'Einzel-Memories'],
            ['legacy', 'Legacy-Markdown']
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              style={{
                ...buttonStyle({
                  accent: tab === key
                }),
                flex: 1
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 250,
            overflowY: 'auto',
            padding: 15
          }}
        >
          {tab === 'items' ? (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 13
                }}
              >
                <select
                  value={itemFilter}
                  onChange={event =>
                    setItemFilter(
                      event.target.value
                    )
                  }
                  style={{
                    ...fieldStyle(),
                    width: 'auto'
                  }}
                >
                  <option value="active">
                    Nur aktive
                  </option>
                  <option value="all">
                    Alle Status
                  </option>
                </select>

                <button
                  type="button"
                  onClick={loadItems}
                  disabled={itemsLoading}
                  style={buttonStyle({
                    disabled: itemsLoading
                  })}
                >
                  Neu laden
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setCreating(true)
                  }
                  disabled={creating}
                  style={{
                    ...buttonStyle({
                      accent: true,
                      disabled: creating
                    }),
                    marginLeft: 'auto'
                  }}
                >
                  Neue Memory
                </button>
              </div>

              {creating && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: 13,
                    border:
                      '1px solid var(--accent)',
                    borderRadius: 10,
                    background: 'var(--bg1)'
                  }}
                >
                  <ItemEditor
                    value={createDraft}
                    onChange={setCreateDraft}
                    onSave={createItem}
                    onCancel={() => {
                      setCreating(false)
                      setCreateDraft(emptyItem)
                    }}
                    saving={
                      actionId === 'create'
                    }
                    saveLabel="Memory anlegen"
                  />
                </div>
              )}

              {itemsLoading ? (
                <div
                  style={{
                    color: 'var(--text3)'
                  }}
                >
                  Memories werden geladen …
                </div>
              ) : visibleItems.length ? (
                <div
                  style={{
                    display: 'grid',
                    gap: 10
                  }}
                >
                  {visibleItems.map(item => (
                    <article
                      key={item.id}
                      style={{
                        padding: 13,
                        border:
                          '1px solid var(--border)',
                        borderRadius: 10,
                        background: 'var(--bg1)'
                      }}
                    >
                      {editingId === item.id ? (
                        <ItemEditor
                          value={editDraft}
                          onChange={setEditDraft}
                          onSave={() =>
                            saveItem(item.id)
                          }
                          onCancel={() => {
                            setEditingId(null)
                            setEditDraft(null)
                          }}
                          saving={
                            actionId === item.id
                          }
                        />
                      ) : (
                        <>
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              alignItems: 'center',
                              gap: 7,
                              marginBottom: 9
                            }}
                          >
                            <span
                              style={{
                                padding: '3px 7px',
                                borderRadius: 999,
                                background:
                                  'var(--bg3)',
                                color:
                                  'var(--accent)',
                                fontFamily:
                                  'var(--font-mono)',
                                fontSize: 10
                              }}
                            >
                              {
                                TYPE_LABELS[
                                  item.type
                                ] || item.type
                              }
                            </span>

                            <span
                              style={{
                                color:
                                  'var(--text3)',
                                fontFamily:
                                  'var(--font-mono)',
                                fontSize: 10
                              }}
                            >
                              {item.scope}
                            </span>

                            <span
                              style={{
                                marginLeft: 'auto',
                                color:
                                  item.status ===
                                  'active'
                                    ? 'var(--accent)'
                                    : 'var(--text3)',
                                fontFamily:
                                  'var(--font-mono)',
                                fontSize: 10
                              }}
                            >
                              {
                                STATUS_LABELS[
                                  item.status
                                ] || item.status
                              }
                            </span>
                          </div>

                          <div
                            style={{
                              whiteSpace:
                                'pre-wrap',
                              overflowWrap:
                                'anywhere',
                              color:
                                'var(--text1)',
                              fontSize: 13,
                              lineHeight: 1.55
                            }}
                          >
                            {item.content}
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '5px 14px',
                              marginTop: 10,
                              color:
                                'var(--text3)',
                              fontFamily:
                                'var(--font-mono)',
                              fontSize: 9
                            }}
                          >
                            <span>
                              Wichtigkeit: {
                                item.importance
                              }
                            </span>

                            <span>
                              Sicherheit: {
                                Number(
                                  item.confidence
                                ).toFixed(2)
                              }
                            </span>

                            {item.lastConfirmedAt && (
                              <span>
                                Bestätigt: {
                                  dateText(
                                    item.lastConfirmedAt
                                  )
                                }
                              </span>
                            )}

                            {item.sourceConversationId && (
                              <span>
                                Quelle: Chat {
                                  item.sourceConversationId
                                }
                              </span>
                            )}

                            {item.expiresAt && (
                              <span>
                                Läuft ab: {
                                  dateText(
                                    item.expiresAt
                                  )
                                }
                              </span>
                            )}
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              justifyContent:
                                'flex-end',
                              gap: 7,
                              marginTop: 11
                            }}
                          >
                            {item.status ===
                              'active' && (
                              <button
                                type="button"
                                onClick={() =>
                                  confirmItem(
                                    item.id
                                  )
                                }
                                disabled={
                                  actionId ===
                                  item.id
                                }
                                style={buttonStyle({
                                  disabled:
                                    actionId ===
                                    item.id
                                })}
                              >
                                Bestätigen
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() =>
                                beginEdit(item)
                              }
                              disabled={
                                actionId ===
                                item.id
                              }
                              style={buttonStyle({
                                disabled:
                                  actionId ===
                                  item.id
                              })}
                            >
                              Bearbeiten
                            </button>

                            {item.status ===
                            'active' ? (
                              <button
                                type="button"
                                onClick={() =>
                                  archiveItem(
                                    item.id
                                  )
                                }
                                disabled={
                                  actionId ===
                                  item.id
                                }
                                style={buttonStyle({
                                  disabled:
                                    actionId ===
                                    item.id
                                })}
                              >
                                Archivieren
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  restoreItem(
                                    item.id
                                  )
                                }
                                disabled={
                                  actionId ===
                                  item.id
                                }
                                style={buttonStyle({
                                  disabled:
                                    actionId ===
                                    item.id
                                })}
                              >
                                Wiederherstellen
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() =>
                                deleteItem(item)
                              }
                              disabled={
                                actionId ===
                                item.id
                              }
                              style={buttonStyle({
                                danger: true,
                                disabled:
                                  actionId ===
                                  item.id
                              })}
                            >
                              Löschen
                            </button>
                          </div>
                        </>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    padding: 30,
                    textAlign: 'center',
                    color: 'var(--text3)'
                  }}
                >
                  Noch keine strukturierten
                  Einzel-Memories vorhanden.
                </div>
              )}

              {itemError && (
                <div
                  style={{
                    marginTop: 13,
                    padding: 10,
                    border:
                      '1px solid var(--danger)',
                    borderRadius: 8,
                    color: 'var(--danger)',
                    fontSize: 12
                  }}
                >
                  {itemError}
                </div>
              )}
            </>
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginBottom: 13
                }}
              >
                {!legacyEditing ? (
                  <button
                    type="button"
                    onClick={() => {
                      setLegacyDraft(memory)
                      setLegacyEditing(true)
                    }}
                    disabled={legacyLoading}
                    style={buttonStyle({
                      disabled: legacyLoading
                    })}
                  >
                    Bearbeiten
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setLegacyDraft(memory)
                        setLegacyEditing(false)
                      }}
                      disabled={legacySaving}
                      style={buttonStyle({
                        disabled: legacySaving
                      })}
                    >
                      Abbrechen
                    </button>

                    <button
                      type="button"
                      onClick={saveLegacy}
                      disabled={legacySaving}
                      style={buttonStyle({
                        accent: true,
                        disabled: legacySaving
                      })}
                    >
                      {legacySaving
                        ? 'Speichere …'
                        : 'Speichern'}
                    </button>
                  </>
                )}

                <button
                  type="button"
                  onClick={loadLegacy}
                  disabled={legacyLoading}
                  style={buttonStyle({
                    disabled: legacyLoading
                  })}
                >
                  Neu laden
                </button>

                <button
                  type="button"
                  onClick={updateLegacy}
                  disabled={
                    legacyLoading ||
                    legacyUpdating ||
                    streaming
                  }
                  style={buttonStyle({
                    accent: true,
                    disabled:
                      legacyLoading ||
                      legacyUpdating ||
                      streaming
                  })}
                >
                  {legacyUpdating
                    ? 'Aktualisiere …'
                    : 'Aus Chat aktualisieren'}
                </button>

                <button
                  type="button"
                  onClick={clearLegacy}
                  disabled={legacyDeleting}
                  style={{
                    ...buttonStyle({
                      danger: true,
                      disabled:
                        legacyDeleting
                    }),
                    marginLeft: 'auto'
                  }}
                >
                  {legacyDeleting
                    ? 'Lösche …'
                    : 'Legacy löschen'}
                </button>
              </div>

              {legacyLoading ? (
                <div
                  style={{
                    color: 'var(--text3)'
                  }}
                >
                  Legacy-Memory wird geladen …
                </div>
              ) : legacyEditing ? (
                <textarea
                  autoFocus
                  value={legacyDraft}
                  onChange={event =>
                    setLegacyDraft(
                      event.target.value
                    )
                  }
                  rows={18}
                  style={{
                    ...fieldStyle(),
                    resize: 'vertical',
                    lineHeight: 1.6
                  }}
                />
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
                    remarkPlugins={[
                      remarkGfm
                    ]}
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
                  Kein Legacy-Memory vorhanden.
                </div>
              )}

              {legacyError && (
                <div
                  style={{
                    marginTop: 13,
                    padding: 10,
                    border:
                      '1px solid var(--danger)',
                    borderRadius: 8,
                    color: 'var(--danger)',
                    fontSize: 12
                  }}
                >
                  {legacyError}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
