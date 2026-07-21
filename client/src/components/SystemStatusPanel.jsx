function formatDuration(seconds) {
  const value = Math.max(
    0,
    Math.floor(Number(seconds) || 0)
  )
  const days = Math.floor(value / 86400)
  const hours = Math.floor(value % 86400 / 3600)
  const minutes = Math.floor(value % 3600 / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function backupAge(backup) {
  if (!backup?.found) return 'Fehlt'
  return `vor ${formatDuration(backup.ageSeconds)}`
}

function formatTimestamp(value) {
  if (!value) return 'Noch nie'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return 'Unbekannt'

  return date.toLocaleString('de-AT', {
    dateStyle: 'short',
    timeStyle: 'short'
  })
}

function mcpState(server) {
  if (server?.reachable === true) return 'Erreichbar'
  if (server?.reachable === false) return 'Nicht erreichbar'
  return 'Unbekannt'
}

function booleanLabel(value) {
  return value ? 'Ja' : 'Nein'
}

function Metric({
  label,
  value,
  detail,
  warning = false
}) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>
        {label}
      </span>

      <strong
        style={{
          ...styles.metricValue,
          color: warning
            ? 'var(--danger)'
            : 'var(--text1)'
        }}
      >
        {value}
      </strong>

      {detail && (
        <span style={styles.metricDetail}>
          {detail}
        </span>
      )}
    </div>
  )
}

export default function SystemStatusPanel({
  status,
  monitoredApps,
  onToggleApp,
  onClose
}) {
  const databaseWarning =
    !status?.backups?.database?.found ||
    Number(status?.backups?.database?.ageSeconds) >
      172800

  const fullWarning =
    !status?.backups?.full?.found ||
    Number(status?.backups?.full?.ageSeconds) >
      1209600

  const monitoredProcessWarning =
    (status?.apps || []).some(
      app =>
        monitoredApps.includes(app.name) &&
        app.status !== 'online'
    )

  const mcpWarning =
    (status?.mcpServers || []).some(server =>
      server.mode === 'active' &&
      (
        server.reachable !== true ||
        server.circuitBreaker?.state === 'open'
      )
    )

  const systemWarning =
    monitoredProcessWarning ||
    mcpWarning ||
    Number(status?.memory?.usedPercent) >= 90 ||
    Number(status?.disk) >= 90 ||
    Number(status?.cpu) >= 95 ||
    databaseWarning ||
    fullWarning

  return (
    <div
      className="echolink-fullscreen-overlay"
      onClick={onClose}
      style={styles.overlay}
    >
      <section
        className="echolink-fullscreen-panel"
        onClick={event => event.stopPropagation()}
        style={styles.panel}
      >
        <header style={styles.header}>
          <div style={styles.headerText}>
            <strong style={styles.title}>
              Systemstatus
            </strong>

            <span style={styles.subtitle}>
              Prozesse, Ressourcen, MCP und Backups
            </span>
          </div>

          <span
            style={{
              ...styles.health,
              color: systemWarning
                ? 'var(--danger)'
                : 'var(--accent)'
            }}
          >
            {systemWarning
              ? 'Prüfen'
              : 'Alles okay'}
          </span>

          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            style={styles.close}
          >
            ×
          </button>
        </header>

        <div style={styles.body}>
          <div style={styles.sectionTitle}>
            Ressourcen
          </div>

          <div style={styles.metricGrid}>
            <Metric
              label="CPU"
              value={`${status?.cpu ?? '–'} %`}
              detail={`Load ${status?.load ?? '–'}`}
              warning={Number(status?.cpu) >= 95}
            />

            <Metric
              label="RAM"
              value={`${status?.memory?.usedPercent ?? '–'} %`}
              detail={
                status?.memory
                  ? `${status.memory.usedMb}/${status.memory.totalMb} MB`
                  : ''
              }
              warning={
                Number(status?.memory?.usedPercent) >= 90
              }
            />

            <Metric
              label="Speicher"
              value={`${status?.disk ?? '–'} %`}
              detail={
                status?.diskFreeGb != null
                  ? `${status.diskFreeGb} GB frei`
                  : ''
              }
              warning={Number(status?.disk) >= 90}
            />

            <Metric
              label="Uptime"
              value={formatDuration(status?.uptimeSeconds)}
            />
          </div>

          <div style={styles.sectionTitle}>
            Überwachte Prozesse
          </div>

          <div style={styles.processList}>
            {(status?.apps || []).map(app => {
              const monitored =
                monitoredApps.includes(app.name)

              return (
                <button
                  key={app.name}
                  type="button"
                  onClick={() => onToggleApp(app.name)}
                  style={{
                    ...styles.process,
                    opacity: monitored ? 1 : 0.55
                  }}
                >
                  <span
                    style={{
                      ...styles.processDot,
                      background:
                        app.status === 'online'
                          ? 'var(--accent)'
                          : 'var(--danger)'
                    }}
                  />

                  <span style={styles.processName}>
                    {app.name}
                  </span>

                  <span style={styles.processMeta}>
                    {app.status}
                    {' · '}
                    {app.restarts ?? 0} Neustarts
                    {' · '}
                    {app.cpu ?? 0} %
                    {' · '}
                    {app.memoryMb ?? 0} MB
                  </span>

                  <span style={styles.monitorState}>
                    {monitored
                      ? 'Überwacht'
                      : 'Ausgeblendet'}
                  </span>
                </button>
              )
            })}
          </div>

          <div style={styles.sectionTitle}>
            MCP-Server
          </div>

          <div style={styles.mcpList}>
            {(status?.mcpServers || []).length === 0 && (
              <div style={styles.emptyState}>
                Keine MCP-Server registriert
              </div>
            )}

            {(status?.mcpServers || []).map(server => {
              const warning =
                server.mode === 'active' &&
                (
                  server.reachable !== true ||
                  server.circuitBreaker?.state === 'open'
                )

              return (
                <article
                  key={server.name}
                  style={styles.mcpCard}
                >
                  <div style={styles.mcpHeader}>
                    <span
                      style={{
                        ...styles.processDot,
                        background: warning
                          ? 'var(--danger)'
                          : 'var(--accent)'
                      }}
                    />

                    <strong style={styles.mcpName}>
                      {server.name}
                    </strong>

                    <span style={styles.mcpMode}>
                      {server.mode}
                    </span>
                  </div>

                  <div style={styles.mcpUrl}>
                    {server.url || '–'}
                  </div>

                  <div style={styles.mcpMetricGrid}>
                    <Metric
                      label="Status"
                      value={mcpState(server)}
                      warning={warning}
                    />
                    <Metric
                      label="Latenz"
                      value={server.latencyMs == null
                        ? '–'
                        : `${server.latencyMs} ms`}
                    />
                    <Metric
                      label="Letzte Verbindung"
                      value={formatTimestamp(
                        server.lastSuccessfulConnection
                      )}
                    />
                    <Metric
                      label="Circuit Breaker"
                      value={
                        server.circuitBreaker?.state || '–'
                      }
                      detail={
                        server.circuitBreaker?.openUntil
                          ? `bis ${formatTimestamp(
                              server.circuitBreaker.openUntil
                            )}`
                          : ''
                      }
                      warning={
                        server.circuitBreaker?.state === 'open'
                      }
                    />
                  </div>

                  <div style={styles.counterRow}>
                    <span>Erfolge {server.successCount ?? 0}</span>
                    <span>Fehler {server.errorCount ?? 0}</span>
                    <span>Fallbacks {server.fallbackCount ?? 0}</span>
                  </div>

                  <div style={styles.toolList}>
                    {(server.tools || []).map(tool => (
                      <div
                        key={tool.name}
                        style={styles.toolCard}
                      >
                        <strong style={styles.toolName}>
                          {tool.name}
                        </strong>
                        <span style={styles.toolMeta}>
                          {tool.enabled
                            ? 'Aktiviert'
                            : 'Deaktiviert'}
                          {' · '}
                          {tool.discovered
                            ? 'Entdeckt'
                            : 'Nicht entdeckt'}
                          {' · '}
                          {tool.timeoutMs ?? '–'} ms
                        </span>
                        <span style={styles.toolFlags}>
                          Read-only {booleanLabel(tool.readOnly)}
                          {' · '}
                          Fallback {booleanLabel(
                            tool.fallbackAllowed
                          )}
                        </span>
                      </div>
                    ))}
                  </div>

                  {server.lastError && (
                    <div style={styles.mcpError}>
                      Letzter Fehler: {server.lastError}
                    </div>
                  )}
                </article>
              )
            })}
          </div>

          <div style={styles.sectionTitle}>
            Backups
          </div>

          <div style={styles.backupGrid}>
            <Metric
              label="Datenbank"
              value={backupAge(status?.backups?.database)}
              warning={databaseWarning}
            />

            <Metric
              label="Komplett"
              value={backupAge(status?.backups?.full)}
              warning={fullWarning}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 170,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    background: 'rgba(0,0,0,0.68)',
    backdropFilter: 'blur(4px)'
  },
  panel: {
    width: 'min(760px, 100%)',
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    border: '1px solid var(--border)',
    borderRadius: 15,
    background: 'var(--bg2)',
    boxShadow: '0 24px 70px rgba(0,0,0,0.55)'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)'
  },
  headerText: {
    minWidth: 0,
    flex: 1,
    display: 'grid',
    gap: 3
  },
  title: {
    color: 'var(--text1)',
    fontSize: 18,
    fontWeight: 700
  },
  subtitle: {
    color: 'var(--text3)',
    fontSize: 11
  },
  health: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700
  },
  close: {
    width: 40,
    height: 40,
    flexShrink: 0,
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    fontSize: 22
  },
  body: {
    minHeight: 0,
    overflowY: 'auto',
    padding:
      '16px 16px calc(22px + env(safe-area-inset-bottom))'
  },
  sectionTitle: {
    margin: '4px 2px 9px',
    color: 'var(--text3)',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em'
  },
  metricGrid: {
    display: 'grid',
    gridTemplateColumns:
      'repeat(auto-fit, minmax(135px, 1fr))',
    gap: 8,
    marginBottom: 22
  },
  metric: {
    minWidth: 0,
    display: 'grid',
    gap: 3,
    padding: 12,
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--bg3)'
  },
  metricLabel: {
    color: 'var(--text3)',
    fontSize: 10
  },
  metricValue: {
    fontSize: 17
  },
  metricDetail: {
    color: 'var(--text3)',
    fontSize: 10,
    overflowWrap: 'anywhere'
  },
  processList: {
    display: 'grid',
    gap: 7,
    marginBottom: 22
  },
  process: {
    width: '100%',
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns:
      '10px minmax(90px, auto) minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 9,
    padding: 11,
    border: '1px solid var(--border)',
    borderRadius: 10,
    background: 'var(--bg3)',
    color: 'var(--text1)',
    textAlign: 'left'
  },
  processDot: {
    width: 8,
    height: 8,
    borderRadius: '50%'
  },
  processName: {
    fontSize: 12,
    fontWeight: 700,
    overflowWrap: 'anywhere'
  },
  processMeta: {
    minWidth: 0,
    color: 'var(--text3)',
    fontSize: 10,
    overflowWrap: 'anywhere'
  },
  monitorState: {
    color: 'var(--text2)',
    fontSize: 10
  },
  mcpList: {
    display: 'grid',
    gap: 9,
    marginBottom: 22
  },
  mcpCard: {
    minWidth: 0,
    display: 'grid',
    gap: 10,
    padding: 12,
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--bg3)'
  },
  mcpHeader: {
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: '10px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 9
  },
  mcpName: {
    minWidth: 0,
    color: 'var(--text1)',
    fontSize: 13,
    overflowWrap: 'anywhere'
  },
  mcpMode: {
    padding: '3px 7px',
    border: '1px solid var(--border)',
    borderRadius: 999,
    color: 'var(--text2)',
    fontSize: 9,
    textTransform: 'uppercase'
  },
  mcpUrl: {
    color: 'var(--text3)',
    fontSize: 10,
    overflowWrap: 'anywhere'
  },
  mcpMetricGrid: {
    display: 'grid',
    gridTemplateColumns:
      'repeat(auto-fit, minmax(130px, 1fr))',
    gap: 7
  },
  counterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '5px 12px',
    color: 'var(--text2)',
    fontSize: 10
  },
  toolList: {
    display: 'grid',
    gridTemplateColumns:
      'repeat(auto-fit, minmax(210px, 1fr))',
    gap: 7
  },
  toolCard: {
    minWidth: 0,
    display: 'grid',
    gap: 3,
    padding: 9,
    border: '1px solid var(--border)',
    borderRadius: 9,
    background: 'var(--bg2)'
  },
  toolName: {
    color: 'var(--text1)',
    fontSize: 11,
    overflowWrap: 'anywhere'
  },
  toolMeta: {
    color: 'var(--text2)',
    fontSize: 9,
    overflowWrap: 'anywhere'
  },
  toolFlags: {
    color: 'var(--text3)',
    fontSize: 9,
    overflowWrap: 'anywhere'
  },
  mcpError: {
    padding: 9,
    border: '1px solid var(--border)',
    borderRadius: 9,
    color: 'var(--danger)',
    fontSize: 10,
    overflowWrap: 'anywhere'
  },
  emptyState: {
    padding: 12,
    border: '1px dashed var(--border)',
    borderRadius: 10,
    color: 'var(--text3)',
    fontSize: 11,
    textAlign: 'center'
  },
  backupGrid: {
    display: 'grid',
    gridTemplateColumns:
      'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 8
  }
}
