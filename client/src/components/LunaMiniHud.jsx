import { useEffect, useState } from 'react'

function formatNumber(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) return '–'

  return new Intl.NumberFormat('de-DE', {
    maximumFractionDigits: 0
  }).format(Math.round(number))
}

function contextDetails(usage) {
  const input = Number(
    usage?.context_estimated_input_tokens
  )
  const budget = Number(
    usage?.context_budget_tokens
  )
  const omitted = Number(
    usage?.context_omitted_messages
  )
  const exactOutput = Number(
    usage?.completion_tokens
  )
  const liveOutput = Number(
    usage?.context_live_output_tokens
  )
  const live = Boolean(usage?.context_live)

  const output = live
    ? liveOutput
    : exactOutput

  const safeOutput = Number.isFinite(output)
    ? Math.max(0, output)
    : 0

  const available =
    Number.isFinite(input) &&
    Number.isFinite(budget) &&
    budget > 0

  const used = available
    ? Math.max(0, input) + safeOutput
    : 0

  const percent = available
    ? Math.min(
        100,
        Math.max(0, used / budget * 100)
      )
    : 0

  const warning =
    Boolean(usage?.context_over_budget) ||
    used >= budget ||
    (
      Number.isFinite(omitted) &&
      omitted > 0
    )

  return {
    available,
    input,
    output: safeOutput,
    budget,
    omitted,
    used,
    percent,
    warning,
    live
  }
}

function formatUpdatedAt(updatedAt, now) {
  const timestamp = Number(updatedAt)

  if (!Number.isFinite(timestamp)) {
    return 'Zeitpunkt unbekannt'
  }

  const ageSeconds = Math.max(
    0,
    Math.floor((now - timestamp) / 1000)
  )

  if (ageSeconds < 5) return 'gerade aktualisiert'
  if (ageSeconds < 60) return `vor ${ageSeconds} s aktualisiert`

  const minutes = Math.floor(ageSeconds / 60)
  if (minutes < 60) return `vor ${minutes} min aktualisiert`

  const hours = Math.floor(minutes / 60)
  return `vor ${hours} h aktualisiert`
}

function ExpandableValue({
  field,
  value,
  expandedField,
  onToggle,
  className = ''
}) {
  const expanded = expandedField === field

  return (
    <button
      type="button"
      className={[
        'luna-mini-hud-value',
        'luna-mini-hud-expandable',
        expanded ? 'is-expanded' : '',
        className
      ].filter(Boolean).join(' ')}
      title={value}
      aria-expanded={expanded}
      onClick={() => onToggle(
        expanded ? '' : field
      )}
    >
      {value}
    </button>
  )
}

export default function LunaMiniHud({
  containerRef,
  model,
  requestedModel,
  usage,
  toolText,
  toolDetail,
  toolActive,
  waitingForApproval,
  streaming,
  systemMood,
  status,
  statusUpdatedAt,
  mobile,
  onOpenSystem,
  onClose
}) {
  const [expandedField, setExpandedField] = useState('')
  const [now, setNow] = useState(Date.now())
  const [mobileMaxHeight, setMobileMaxHeight] = useState(null)
  const context = contextDetails(usage)

  useEffect(() => {
    setExpandedField('')
  }, [model, toolDetail, toolText])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 10000)

    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!mobile) {
      setMobileMaxHeight(null)
      return undefined
    }

    let frame = 0

    const updateMaxHeight = () => {
      window.cancelAnimationFrame(frame)

      frame = window.requestAnimationFrame(() => {
        const element = containerRef.current
        if (!element) return

        const viewport = window.visualViewport
        const viewportTop = viewport?.offsetTop || 0
        const viewportHeight =
          viewport?.height || window.innerHeight
        const viewportBottom =
          viewportTop + viewportHeight
        const elementTop =
          element.getBoundingClientRect().top

        setMobileMaxHeight(
          Math.max(
            96,
            Math.floor(viewportBottom - elementTop - 8)
          )
        )
      })
    }

    updateMaxHeight()

    window.addEventListener('resize', updateMaxHeight)
    window.addEventListener('orientationchange', updateMaxHeight)
    window.visualViewport?.addEventListener(
      'resize',
      updateMaxHeight
    )
    window.visualViewport?.addEventListener(
      'scroll',
      updateMaxHeight
    )

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updateMaxHeight)
      window.removeEventListener(
        'orientationchange',
        updateMaxHeight
      )
      window.visualViewport?.removeEventListener(
        'resize',
        updateMaxHeight
      )
      window.visualViewport?.removeEventListener(
        'scroll',
        updateMaxHeight
      )
    }
  }, [containerRef, mobile])

  const toolValue = waitingForApproval
    ? 'Freigabe ausstehend'
    : toolActive && (toolDetail || toolText)
      ? toolDetail || toolText
      : streaming
        ? 'Kein Tool · Antwort läuft'
        : 'Kein Tool aktiv'

  const systemWarning = systemMood === 'panic'
  const systemValue = systemWarning
    ? 'Prüfen'
    : 'Alles okay'

  const systemDetail = status
    ? `CPU ${status.cpu ?? '–'} % · RAM ${status.memory?.usedPercent ?? '–'} % · Speicher ${status.disk ?? '–'} %`
    : 'Status noch nicht geladen'

  const routedModel =
    model &&
    requestedModel &&
    model !== requestedModel

  const contextBreakdown = context.live
    ? `Live-Schätzung · Eingabe ca. ${formatNumber(context.input)} + Ausgabe ca. ${formatNumber(context.output)}`
    : context.output > 0
      ? `Eingabe ${formatNumber(context.input)} + Ausgabe ${formatNumber(context.output)}`
      : 'Serverwert für die Modelleingabe'

  return (
    <section
      ref={containerRef}
      id="luna-mini-hud"
      role="dialog"
      aria-label="Luna Mini-HUD"
      className={[
        'luna-mini-hud',
        mobile
          ? 'luna-mini-hud-mobile'
          : 'luna-mini-hud-desktop'
      ].join(' ')}
      style={
        mobileMaxHeight
          ? { maxHeight: `${mobileMaxHeight}px` }
          : undefined
      }
    >
      <header className="luna-mini-hud-header">
        <div>
          <strong>Luna</strong>
          <span>Mini-HUD</span>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="luna-mini-hud-close"
          aria-label="Luna Mini-HUD schließen"
        >
          ×
        </button>
      </header>

      <div className="luna-mini-hud-grid">
        <div className="luna-mini-hud-row">
          <span className="luna-mini-hud-label">
            Modell
          </span>
          <div className="luna-mini-hud-value-stack">
            <ExpandableValue
              field="model"
              value={model || 'Kein Modell ausgewählt'}
              expandedField={expandedField}
              onToggle={setExpandedField}
              className="luna-mini-hud-model"
            />

            {routedModel ? (
              <small className="luna-mini-hud-note">
                Automatisch geroutet · angefordert: {requestedModel}
              </small>
            ) : context.live ? (
              <small className="luna-mini-hud-note">
                Während der Antwort vorläufig
              </small>
            ) : null}
          </div>
        </div>

        <div className="luna-mini-hud-row luna-mini-hud-context-row">
          <span className="luna-mini-hud-label">
            Kontext
          </span>

          {context.available ? (
            <>
              <strong
                className={[
                  'luna-mini-hud-value',
                  context.warning
                    ? 'luna-mini-hud-warning'
                    : ''
                ].filter(Boolean).join(' ')}
              >
                {context.live && 'ca. '}
                {formatNumber(context.used)} /{' '}
                {formatNumber(context.budget)} ·{' '}
                {context.percent
                  .toFixed(1)
                  .replace('.', ',')}
                %
              </strong>

              <div
                className="luna-mini-hud-progress"
                aria-hidden="true"
              >
                <span
                  className={
                    context.warning
                      ? 'luna-mini-hud-progress-warning'
                      : ''
                  }
                  style={{
                    width: `${Math.max(
                      context.percent,
                      context.percent > 0 ? 1 : 0
                    )}%`
                  }}
                />
              </div>

              <small className="luna-mini-hud-note">
                {contextBreakdown}
              </small>

              {context.warning && (
                <small className="luna-mini-hud-note luna-mini-hud-warning">
                  {Number.isFinite(context.omitted) &&
                  context.omitted > 0
                    ? `${formatNumber(context.omitted)} ältere Nachrichten ausgelassen`
                    : 'Kontextlimit erreicht'}
                </small>
              )}
            </>
          ) : (
            <strong className="luna-mini-hud-value luna-mini-hud-muted">
              Noch keine Daten
            </strong>
          )}
        </div>

        <div className="luna-mini-hud-row">
          <span className="luna-mini-hud-label">
            Tool
          </span>
          <ExpandableValue
            field="tool"
            value={toolValue}
            expandedField={expandedField}
            onToggle={setExpandedField}
            className={
              toolActive || waitingForApproval
                ? 'luna-mini-hud-active'
                : 'luna-mini-hud-muted'
            }
          />
        </div>

        <div className="luna-mini-hud-row">
          <span className="luna-mini-hud-label">
            System
          </span>
          <div className="luna-mini-hud-system">
            <strong
              className={[
                'luna-mini-hud-value',
                systemWarning
                  ? 'luna-mini-hud-warning'
                  : 'luna-mini-hud-healthy'
              ].join(' ')}
            >
              {systemValue}
            </strong>
            <small className="luna-mini-hud-note">
              {systemDetail}
            </small>
            <small
              className="luna-mini-hud-note luna-mini-hud-updated"
              title={
                statusUpdatedAt
                  ? new Date(statusUpdatedAt)
                    .toLocaleString('de-DE')
                  : undefined
              }
            >
              {formatUpdatedAt(statusUpdatedAt, now)}
            </small>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenSystem}
        className="luna-mini-hud-system-button"
      >
        Systemstatus öffnen
        <span aria-hidden="true">›</span>
      </button>
    </section>
  )
}
