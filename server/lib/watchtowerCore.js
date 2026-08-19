export const DEFAULT_WATCHTOWER_APPS = Object.freeze([
  'echolink',
  'echolink-worker',
  'echolink-mcp-web',
  'echolink-mcp-playwright'
])

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

function finding({
  key,
  severity,
  summary,
  detail,
  fingerprint,
  confirmations = 1
}) {
  return {
    key,
    severity,
    summary,
    detail,
    fingerprint,
    confirmations
  }
}

export function evaluateWatchtowerSnapshot(
  snapshot,
  {
    diskWarningPercent = 85,
    expectedApps = DEFAULT_WATCHTOWER_APPS
  } = {}
) {
  const findings = []
  const usedPercent = Number(
    snapshot?.disk?.usedPercent
  )

  if (Number.isFinite(usedPercent)) {
    if (usedPercent >= diskWarningPercent) {
      const criticalAt = Math.min(
        97,
        diskWarningPercent + 7
      )
      const severity = usedPercent >= criticalAt
        ? 'critical'
        : 'warning'
      const freeGb = Number(snapshot?.disk?.freeGb)

      findings.push(finding({
        key: 'disk:root',
        severity,
        summary: severity === 'critical'
          ? 'Root-Speicher ist kritisch knapp'
          : 'Root-Speicher wird knapp',
        detail: [
          `/ ist zu ${usedPercent}% belegt.`,
          Number.isFinite(freeGb)
            ? `${freeGb.toFixed(1)} GB sind frei.`
            : null,
          'Watchtower hat nichts gelöscht.'
        ].filter(Boolean).join(' '),
        fingerprint: severity,
        confirmations: 1
      }))
    }
  } else {
    findings.push(finding({
      key: 'probe:disk',
      severity: 'warning',
      summary: 'Speicherstatus konnte nicht gelesen werden',
      detail: snapshot?.disk?.error ||
        'Die Root-Partition lieferte keine verwertbaren Werte.',
      fingerprint: 'unavailable',
      confirmations: 2
    }))
  }

  const apps = Array.isArray(snapshot?.apps)
    ? snapshot.apps
    : null

  if (!apps) {
    findings.push(finding({
      key: 'probe:pm2',
      severity: 'critical',
      summary: 'PM2-Status konnte nicht gelesen werden',
      detail: snapshot?.appsError ||
        'Die Prozessliste war nicht verfügbar.',
      fingerprint: 'unavailable',
      confirmations: 2
    }))
  } else {
    const byName = new Map(
      apps.map(app => [app.name, app])
    )
    const unhealthy = uniqueSorted(
      expectedApps.filter(name =>
        byName.get(name)?.status !== 'online'
      )
    )

    if (unhealthy.length > 0) {
      findings.push(finding({
        key: 'pm2:required-apps',
        severity: 'critical',
        summary: 'Wichtige EchoLink-Prozesse sind nicht online',
        detail: `Betroffen: ${unhealthy.join(', ')}.`,
        fingerprint: unhealthy.join('|'),
        confirmations: 1
      }))
    }
  }

  const failedHealth = uniqueSorted(
    (snapshot?.health || [])
      .filter(check => check?.ok !== true)
      .map(check => check?.name)
      .filter(Boolean)
  )

  if (failedHealth.length > 0) {
    findings.push(finding({
      key: 'health:local-services',
      severity: 'critical',
      summary: 'Lokale Healthchecks schlagen fehl',
      detail: `Betroffen: ${failedHealth.join(', ')}.`,
      fingerprint: failedHealth.join('|'),
      confirmations: 2
    }))
  }

  const unhealthyMcp = uniqueSorted(
    (snapshot?.mcpServers || [])
      .filter(server =>
        server?.mode === 'active' &&
        (
          server?.configured === false ||
          server?.reachable !== true ||
          server?.circuitBreaker?.state === 'open'
        )
      )
      .map(server => server?.name)
      .filter(Boolean)
  )

  if (unhealthyMcp.length > 0) {
    findings.push(finding({
      key: 'mcp:registry',
      severity: 'warning',
      summary: 'MCP-Server sind nicht vollständig erreichbar',
      detail: `Betroffen: ${unhealthyMcp.join(', ')}.`,
      fingerprint: unhealthyMcp.join('|'),
      confirmations: 2
    }))
  }

  return findings
}

export function formatWatchtowerIncident(
  incident,
  { resolved = false } = {}
) {
  if (resolved) {
    return [
      '## ✅ Watchtower: Entwarnung',
      '',
      `**Behoben:** ${incident.summary}`,
      '',
      'Der betroffene Check ist wieder stabil. Watchtower hat während des Vorfalls keine destruktive Aktion ausgeführt.'
    ].join('\n')
  }

  const label = incident.severity === 'critical'
    ? 'Kritischer Vorfall'
    : 'Warnung'

  return [
    `## ${incident.severity === 'critical' ? '🚨' : '⚠️'} Watchtower: ${label}`,
    '',
    `**Befund:** ${incident.summary}`,
    '',
    incident.detail,
    '',
    'Watchtower beobachtet weiter und meldet die Entwarnung automatisch. Es wurde nichts gelöscht oder destruktiv verändert.'
  ].join('\n')
}
