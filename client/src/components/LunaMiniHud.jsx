function formatNumber(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) return '–'

  return new Intl.NumberFormat('de-DE', {
    maximumFractionDigits: 0
  }).format(Math.round(number))
}

function contextDetails(usage) {
  const estimated = Number(
    usage?.context_estimated_input_tokens
  )
  const budget = Number(
    usage?.context_budget_tokens
  )
  const omitted = Number(
    usage?.context_omitted_messages
  )

  const available =
    Number.isFinite(estimated) &&
    Number.isFinite(budget) &&
    budget > 0

  const percent = available
    ? Math.min(
        100,
        Math.max(0, estimated / budget * 100)
      )
    : 0

  const warning =
    Boolean(usage?.context_over_budget) ||
    (
      Number.isFinite(omitted) &&
      omitted > 0
    )

  return {
    available,
    estimated,
    budget,
    omitted,
    percent,
    warning
  }
}

export default function LunaMiniHud({
  containerRef,
  model,
  usage,
  toolText,
  toolActive,
  waitingForApproval,
  streaming,
  systemMood,
  status,
  mobile,
  onOpenSystem,
  onClose
}) {
  const context = contextDetails(usage)

  const toolValue = waitingForApproval
    ? 'Freigabe ausstehend'
    : toolActive && toolText
      ? toolText
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
          <strong
            className="luna-mini-hud-value luna-mini-hud-model"
            title={model || 'Kein Modell ausgewählt'}
          >
            {model || 'Kein Modell ausgewählt'}
          </strong>
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
                {formatNumber(context.estimated)} /{' '}
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
          <strong
            className={[
              'luna-mini-hud-value',
              toolActive || waitingForApproval
                ? 'luna-mini-hud-active'
                : 'luna-mini-hud-muted'
            ].join(' ')}
          >
            {toolValue}
          </strong>
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
