import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statfs } from 'node:fs/promises'
import db, { DEFAULT_MODEL } from '../db.js'
import { getMcpRegistryStatus } from './mcpRegistry.js'
import { sendPushToUser } from './push.js'
import {
  DEFAULT_WATCHTOWER_APPS,
  SAFE_WATCHTOWER_AUTO_HEAL_APPS,
  evaluateWatchtowerSnapshot,
  formatWatchtowerIncident,
  formatWatchtowerRepair,
  selectWatchtowerAutoHealTargets
} from './watchtowerCore.js'

const execFileAsync = promisify(execFile)

const WATCHTOWER_SYSTEM_GUIDE = `Watchtower is EchoLink's dedicated operations conversation.
Treat Watchtower incident messages as observed system facts, not user claims.
Explain incidents in the user's language. Diagnose with read-only tools first.
Never delete data or perform another destructive action without explicit approval.
Do not repeat a completed repair. Keep normal chat unrelated to Watchtower.`

const DEFAULT_DISK_WARNING_PERCENT = 85

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function safeError(error) {
  return String(error?.message || error || 'Unbekannter Fehler')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 500)
}

function parseExpectedApps(env = process.env) {
  const configured = String(
    env.WATCHTOWER_PM2_APPS || ''
  )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)

  return configured.length > 0
    ? [...new Set(configured)]
    : [...DEFAULT_WATCHTOWER_APPS]
}

async function restartPm2App(appName) {
  await execFileAsync(
    'pm2',
    ['restart', appName],
    {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  )
}

function waitForRepairSettle() {
  return new Promise(resolve => setTimeout(resolve, 1_500))
}

export function ensureWatchtowerSettings(
  database,
  userId
) {
  database.prepare(`
    INSERT INTO watchtower_settings (user_id)
    VALUES (?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId)

  return database.prepare(`
    SELECT *
    FROM watchtower_settings
    WHERE user_id = ?
  `).get(userId)
}

function watchtowerConversation(database, setting) {
  if (!setting?.conversation_id) return null

  return database.prepare(`
    SELECT *
    FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(setting.conversation_id, setting.user_id)
}

export function ensureWatchtowerConversation(
  database,
  userId
) {
  let setting = ensureWatchtowerSettings(
    database,
    userId
  )
  let conversation = watchtowerConversation(
    database,
    setting
  )

  if (conversation) {
    if (conversation.archived_at) {
      database.prepare(`
        UPDATE conversations
        SET archived_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND user_id = ?
      `).run(conversation.id, userId)

      conversation = database.prepare(`
        SELECT * FROM conversations WHERE id = ?
      `).get(conversation.id)
    }

    return conversation
  }

  const user = database.prepare(`
    SELECT default_system_prompt
    FROM users
    WHERE id = ?
  `).get(userId)

  if (!user) {
    throw new Error('Watchtower-Benutzer existiert nicht')
  }

  const template = database.prepare(`
    SELECT model, temperature, top_k, top_p,
      reasoning_effort
    FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(userId)

  const basePrompt = String(
    user.default_system_prompt ||
    process.env.DEFAULT_SYSTEM_PROMPT ||
    ''
  ).trim()

  const systemPrompt = [
    basePrompt,
    WATCHTOWER_SYSTEM_GUIDE
  ].filter(Boolean).join('\n\n')

  const created = database.prepare(`
    INSERT INTO conversations (
      user_id,
      title,
      model,
      system_prompt,
      temperature,
      top_k,
      top_p,
      reasoning_effort
    )
    VALUES (?, 'Watchtower', ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    template?.model || DEFAULT_MODEL,
    systemPrompt,
    template?.temperature ?? 0.5,
    template?.top_k ?? 40,
    template?.top_p ?? 0.9,
    template?.reasoning_effort || ''
  )

  const conversationId = Number(created.lastInsertRowid)

  database.prepare(`
    UPDATE watchtower_settings
    SET conversation_id = ?, updated_at = unixepoch()
    WHERE user_id = ?
  `).run(conversationId, userId)

  return database.prepare(`
    SELECT * FROM conversations WHERE id = ?
  `).get(conversationId)
}

async function readDisk() {
  try {
    const stats = await statfs('/')
    const total = Number(stats.blocks) * Number(stats.bsize)
    const free = Number(stats.bavail) * Number(stats.bsize)
    const usedPercent = total > 0
      ? Math.round((total - free) / total * 100)
      : null

    return {
      usedPercent,
      freeGb: free / 1024 / 1024 / 1024
    }
  } catch (error) {
    return {
      usedPercent: null,
      freeGb: null,
      error: safeError(error)
    }
  }
}

async function readPm2Apps() {
  try {
    const { stdout } = await execFileAsync(
      'pm2',
      ['jlist'],
      {
        timeout: 8_000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true
      }
    )
    const parsed = JSON.parse(stdout)

    return {
      apps: parsed.map(process => ({
        name: process.name,
        status: process.pm2_env?.status || 'unknown'
      })),
      error: null
    }
  } catch (error) {
    return {
      apps: null,
      error: safeError(error)
    }
  }
}

async function localHealth(name, url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      redirect: 'error'
    })

    return {
      name,
      ok: response.ok,
      status: response.status
    }
  } catch (error) {
    return {
      name,
      ok: false,
      status: null,
      error: safeError(error)
    }
  }
}

export async function collectWatchtowerSnapshot() {
  const [
    disk,
    pm2,
    health,
    mcpServers
  ] = await Promise.all([
    readDisk(),
    readPm2Apps(),
    Promise.all([
      localHealth('EchoLink', 'http://127.0.0.1:3000/'),
      localHealth('MCP Web', 'http://127.0.0.1:3011/health')
    ]),
    getMcpRegistryStatus().catch(error => [{
      name: 'MCP Registry',
      mode: 'active',
      configured: true,
      reachable: false,
      lastError: safeError(error),
      circuitBreaker: { state: 'closed' }
    }])
  ])

  return {
    disk,
    apps: pm2.apps,
    appsError: pm2.error,
    health,
    mcpServers
  }
}

function resetRepairStateForHealthyApps(
  database,
  snapshot
) {
  if (!Array.isArray(snapshot?.apps)) return

  const clear = database.prepare(`
    DELETE FROM watchtower_repair_state
    WHERE app_name = ?
  `)

  for (const app of snapshot.apps) {
    if (
      app?.status === 'online' &&
      SAFE_WATCHTOWER_AUTO_HEAL_APPS.includes(app.name)
    ) {
      clear.run(app.name)
    }
  }
}

function pm2FindingFingerprint(snapshot, expectedApps) {
  return evaluateWatchtowerSnapshot(snapshot, {
    expectedApps
  }).find(item => item.key === 'pm2:required-apps')
    ?.fingerprint || 'pm2-unhealthy'
}

async function performWatchtowerRepairs({
  database,
  snapshot,
  expectedApps,
  checkedAt,
  restartApp,
  collectSnapshot,
  settle
}) {
  resetRepairStateForHealthyApps(database, snapshot)

  const targets = selectWatchtowerAutoHealTargets(
    snapshot,
    { expectedApps }
  )
  const fingerprint = pm2FindingFingerprint(
    snapshot,
    expectedApps
  )
  const attempted = []
  const findState = database.prepare(`
    SELECT * FROM watchtower_repair_state
    WHERE app_name = ?
  `)
  const reserve = database.prepare(`
    INSERT OR IGNORE INTO watchtower_repair_state (
      app_name,
      incident_fingerprint,
      status,
      attempted_at,
      verified_at,
      detail
    )
    VALUES (?, ?, 'attempting', ?, NULL, '')
  `)

  for (const appName of targets) {
    if (findState.get(appName)) continue

    const reserved = reserve.run(
      appName,
      fingerprint,
      checkedAt
    )
    if (!reserved.changes) continue

    let commandError = null

    try {
      await restartApp(appName)
    } catch (error) {
      commandError = safeError(error)
    }

    attempted.push({ appName, commandError })
  }

  if (attempted.length === 0) {
    return { attempts: [], snapshot }
  }

  await settle()

  let verifiedSnapshot
  let verificationError = null

  try {
    verifiedSnapshot = await collectSnapshot()
  } catch (error) {
    verificationError = safeError(error)
    verifiedSnapshot = snapshot
  }

  const verifiedApps = new Map(
    Array.isArray(verifiedSnapshot?.apps)
      ? verifiedSnapshot.apps.map(app => [app?.name, app])
      : []
  )
  const finish = database.prepare(`
    UPDATE watchtower_repair_state
    SET status = ?, verified_at = ?, detail = ?
    WHERE app_name = ? AND status = 'attempting'
  `)
  const record = database.prepare(`
    INSERT INTO watchtower_repair_history (
      app_name,
      incident_fingerprint,
      status,
      attempted_at,
      verified_at,
      detail
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const finalize = database.transaction(({
    appName,
    status,
    detail
  }) => {
    const updated = finish.run(
      status,
      checkedAt,
      detail,
      appName
    )

    if (updated.changes) {
      record.run(
        appName,
        fingerprint,
        status,
        checkedAt,
        checkedAt,
        detail
      )
    }
  })
  const results = attempted.map(attempt => {
    const online =
      verifiedApps.get(attempt.appName)?.status === 'online'
    const ok = !attempt.commandError && online
    const detail = attempt.commandError ||
      verificationError ||
      (online
        ? 'PM2 meldet den Prozess als online.'
        : 'PM2 meldet den Prozess nach dem Neustartversuch nicht als online.')

    finalize({
      appName: attempt.appName,
      status: ok ? 'succeeded' : 'failed',
      detail
    })

    return {
      appName: attempt.appName,
      ok,
      detail
    }
  })

  return {
    attempts: results,
    snapshot: verifiedSnapshot
  }
}

function reconcileUser(
  database,
  setting,
  findings,
  checkedAt
) {
  const existing = database.prepare(`
    SELECT *
    FROM watchtower_incidents
    WHERE user_id = ?
  `).all(setting.user_id)
  const byKey = new Map(
    existing.map(row => [row.monitor_key, row])
  )
  const activeKeys = new Set()
  const events = []

  for (const current of findings) {
    activeKeys.add(current.key)
    const previous = byKey.get(current.key)
    const confirmations = Math.max(
      1,
      Number(current.confirmations) || 1
    )

    if (!previous || previous.status === 'resolved') {
      const status = confirmations === 1
        ? 'open'
        : 'pending'

      database.prepare(`
        INSERT INTO watchtower_incidents (
          user_id, monitor_key, status, severity,
          fingerprint, summary, detail, opened_at,
          last_seen_at, resolved_at, last_notified_at,
          consecutive_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)
        ON CONFLICT(user_id, monitor_key) DO UPDATE SET
          status = excluded.status,
          severity = excluded.severity,
          fingerprint = excluded.fingerprint,
          summary = excluded.summary,
          detail = excluded.detail,
          opened_at = excluded.opened_at,
          last_seen_at = excluded.last_seen_at,
          resolved_at = NULL,
          last_notified_at = excluded.last_notified_at,
          consecutive_count = 1
      `).run(
        setting.user_id,
        current.key,
        status,
        current.severity,
        current.fingerprint,
        current.summary,
        current.detail,
        checkedAt,
        checkedAt,
        status === 'open' ? checkedAt : null
      )

      if (status === 'open') {
        events.push({ type: 'opened', ...current })
      }
      continue
    }

    const sameFingerprint =
      previous.fingerprint === current.fingerprint &&
      previous.severity === current.severity

    if (previous.status === 'pending') {
      const count = sameFingerprint
        ? previous.consecutive_count + 1
        : 1
      const status = count >= confirmations
        ? 'open'
        : 'pending'

      database.prepare(`
        UPDATE watchtower_incidents
        SET status = ?, severity = ?, fingerprint = ?,
          summary = ?, detail = ?, last_seen_at = ?,
          last_notified_at = ?, consecutive_count = ?
        WHERE id = ?
      `).run(
        status,
        current.severity,
        current.fingerprint,
        current.summary,
        current.detail,
        checkedAt,
        status === 'open' ? checkedAt : null,
        count,
        previous.id
      )

      if (status === 'open') {
        events.push({ type: 'opened', ...current })
      }
      continue
    }

    database.prepare(`
      UPDATE watchtower_incidents
      SET severity = ?, fingerprint = ?, summary = ?,
        detail = ?, last_seen_at = ?, consecutive_count = ?
      WHERE id = ?
    `).run(
      current.severity,
      current.fingerprint,
      current.summary,
      current.detail,
      checkedAt,
      previous.consecutive_count + 1,
      previous.id
    )

    if (!sameFingerprint) {
      database.prepare(`
        UPDATE watchtower_incidents
        SET last_notified_at = ?
        WHERE id = ?
      `).run(checkedAt, previous.id)

      events.push({ type: 'changed', ...current })
    }
  }

  for (const previous of existing) {
    if (activeKeys.has(previous.monitor_key)) continue

    if (previous.status === 'pending') {
      database.prepare(`
        DELETE FROM watchtower_incidents WHERE id = ?
      `).run(previous.id)
      continue
    }

    if (previous.status === 'open') {
      database.prepare(`
        UPDATE watchtower_incidents
        SET status = 'resolved', resolved_at = ?,
          last_seen_at = ?, consecutive_count = 0
        WHERE id = ?
      `).run(checkedAt, checkedAt, previous.id)

      events.push({
        type: 'resolved',
        key: previous.monitor_key,
        severity: previous.severity,
        summary: previous.summary,
        detail: previous.detail,
        fingerprint: previous.fingerprint
      })
    }
  }

  database.prepare(`
    UPDATE watchtower_settings
    SET last_check_at = ?, last_success_at = ?,
      last_error = NULL, updated_at = ?
    WHERE user_id = ?
  `).run(
    checkedAt,
    checkedAt,
    checkedAt,
    setting.user_id
  )

  return events
}

async function publishEvent(
  database,
  userId,
  conversation,
  event
) {
  const resolved = event.type === 'resolved'
  const content = formatWatchtowerIncident(
    event,
    { resolved }
  )

  database.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (?, 'assistant', ?)
  `).run(conversation.id, content)

  database.prepare(`
    UPDATE conversations
    SET updated_at = unixepoch()
    WHERE id = ?
  `).run(conversation.id)

  const pushResult = await sendPushToUser(userId, {
    title: resolved
      ? 'Watchtower: Entwarnung'
      : event.severity === 'critical'
        ? 'Watchtower: Kritischer Vorfall'
        : 'Watchtower: Warnung',
    body: event.summary,
    url: `/?conversation=${conversation.id}`,
    tag: `echolink-watchtower-${event.key}`,
    conversationId: conversation.id
  })

  console.log(JSON.stringify({
    level: 'info',
    event: 'watchtower_notification',
    userId,
    monitorKey: event.key,
    state: event.type,
    sent: pushResult.sent,
    failed: pushResult.failed
  }))
}

async function publishRepairEvent(
  database,
  userId,
  conversation,
  repair
) {
  database.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (?, 'assistant', ?)
  `).run(
    conversation.id,
    formatWatchtowerRepair(repair)
  )

  database.prepare(`
    UPDATE conversations
    SET updated_at = unixepoch()
    WHERE id = ?
  `).run(conversation.id)

  const pushResult = await sendPushToUser(userId, {
    title: repair.ok
      ? 'Watchtower: Automatisch behoben'
      : 'Watchtower: Auto-Healing fehlgeschlagen',
    body: repair.ok
      ? `${repair.appName} ist wieder online.`
      : `${repair.appName} braucht manuelle Prüfung.`,
    url: `/?conversation=${conversation.id}`,
    tag: `echolink-watchtower-repair-${repair.appName}`,
    conversationId: conversation.id
  })

  console.log(JSON.stringify({
    level: repair.ok ? 'info' : 'warn',
    event: 'watchtower_auto_heal',
    userId,
    appName: repair.appName,
    result: repair.ok ? 'succeeded' : 'failed',
    sent: pushResult.sent,
    failed: pushResult.failed
  }))
}

export async function runWatchtowerCycle({
  database = db,
  snapshot,
  env = process.env,
  checkedAt = nowSeconds(),
  restartApp = restartPm2App,
  collectSnapshot = collectWatchtowerSnapshot,
  settle = waitForRepairSettle
} = {}) {
  const users = database.prepare(`
    SELECT id FROM users ORDER BY id ASC
  `).all()

  if (users.length === 0) {
    return { users: 0, events: 0 }
  }

  const expectedApps = parseExpectedApps(env)
  const currentSnapshot = snapshot ||
    await collectSnapshot()
  let eventCount = 0
  const activeUsers = []

  for (const user of users) {
    try {
      const setting = ensureWatchtowerSettings(
        database,
        user.id
      )

      if (!setting.enabled) continue

      const conversation = ensureWatchtowerConversation(
        database,
        user.id
      )
      activeUsers.push({ user, setting, conversation })
      const findings = evaluateWatchtowerSnapshot(
        currentSnapshot,
        {
          diskWarningPercent:
            setting.disk_warning_percent,
          expectedApps
        }
      )

      const events = database.transaction(() =>
        reconcileUser(
          database,
          setting,
          findings,
          checkedAt
        )
      )()

      for (const event of events) {
        await publishEvent(
          database,
          user.id,
          conversation,
          event
        )
        eventCount++
      }
    } catch (error) {
      const message = safeError(error)

      database.prepare(`
        UPDATE watchtower_settings
        SET last_check_at = ?, last_error = ?, updated_at = ?
        WHERE user_id = ?
      `).run(
        checkedAt,
        message,
        checkedAt,
        user.id
      )

      console.error(JSON.stringify({
        level: 'error',
        event: 'watchtower_user_cycle_failed',
        userId: user.id,
        error: message
      }))
    }
  }

  if (activeUsers.length > 0) {
    try {
      const repairRun = await performWatchtowerRepairs({
        database,
        snapshot: currentSnapshot,
        expectedApps,
        checkedAt,
        restartApp,
        collectSnapshot,
        settle
      })

      if (repairRun.attempts.length > 0) {
        for (const context of activeUsers) {
          for (const repair of repairRun.attempts) {
            await publishRepairEvent(
              database,
              context.user.id,
              context.conversation,
              repair
            )
            eventCount++
          }
        }

        for (const context of activeUsers) {
          const findings = evaluateWatchtowerSnapshot(
            repairRun.snapshot,
            {
              diskWarningPercent:
                context.setting.disk_warning_percent,
              expectedApps
            }
          )
          const events = database.transaction(() =>
            reconcileUser(
              database,
              context.setting,
              findings,
              checkedAt
            )
          )()
          const repairedPm2Completely =
            repairRun.attempts.some(repair => repair.ok) &&
            !findings.some(
              finding => finding.key === 'pm2:required-apps'
            )

          for (const event of events) {
            if (
              repairedPm2Completely &&
              event.type === 'resolved' &&
              event.key === 'pm2:required-apps'
            ) {
              continue
            }

            await publishEvent(
              database,
              context.user.id,
              context.conversation,
              event
            )
            eventCount++
          }
        }
      }
    } catch (error) {
      const message = safeError(error)

      for (const context of activeUsers) {
        database.prepare(`
          UPDATE watchtower_settings
          SET last_error = ?, updated_at = ?
          WHERE user_id = ?
        `).run(
          message,
          checkedAt,
          context.user.id
        )
      }

      console.error(JSON.stringify({
        level: 'error',
        event: 'watchtower_auto_heal_cycle_failed',
        error: message
      }))
    }
  }

  return {
    users: users.length,
    events: eventCount
  }
}

export function getWatchtowerStatus(
  database,
  userId
) {
  const setting = database.prepare(`
    SELECT *
    FROM watchtower_settings
    WHERE user_id = ?
  `).get(userId)

  const incidents = database.prepare(`
    SELECT monitor_key, severity, summary, detail,
      opened_at, last_seen_at
    FROM watchtower_incidents
    WHERE user_id = ? AND status = 'open'
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
      opened_at ASC
  `).all(userId)
  const lastRepair = database.prepare(`
    SELECT app_name, status, attempted_at,
      verified_at, detail
    FROM (
      SELECT app_name, status, attempted_at,
        verified_at, detail, 0 AS source_order
      FROM watchtower_repair_state
      WHERE status = 'attempting'

      UNION ALL

      SELECT app_name, status, attempted_at,
        verified_at, detail, 1 AS source_order
      FROM watchtower_repair_history
    )
    ORDER BY attempted_at DESC, source_order ASC, app_name ASC
    LIMIT 1
  `).get()

  return {
    enabled: setting ? Boolean(setting.enabled) : true,
    conversationId: setting?.conversation_id || null,
    diskWarningPercent:
      setting?.disk_warning_percent ||
      DEFAULT_DISK_WARNING_PERCENT,
    lastCheckAt: setting?.last_check_at || null,
    lastSuccessAt: setting?.last_success_at || null,
    lastError: setting?.last_error || null,
    autoHealing: {
      enabled: setting ? Boolean(setting.enabled) : true,
      policy: 'single-attempt-until-healthy',
      allowedApps: [...SAFE_WATCHTOWER_AUTO_HEAL_APPS],
      lastAttempt: lastRepair
        ? {
            appName: lastRepair.app_name,
            status: lastRepair.status,
            attemptedAt: lastRepair.attempted_at,
            verifiedAt: lastRepair.verified_at,
            detail: lastRepair.detail
          }
        : null
    },
    incidents: incidents.map(incident => ({
      key: incident.monitor_key,
      severity: incident.severity,
      summary: incident.summary,
      detail: incident.detail,
      openedAt: incident.opened_at,
      lastSeenAt: incident.last_seen_at
    }))
  }
}

export function setWatchtowerEnabled(
  database,
  userId,
  enabled
) {
  ensureWatchtowerSettings(database, userId)

  database.prepare(`
    UPDATE watchtower_settings
    SET enabled = ?, updated_at = unixepoch()
    WHERE user_id = ?
  `).run(enabled ? 1 : 0, userId)

  if (enabled) {
    ensureWatchtowerConversation(database, userId)
  }

  return getWatchtowerStatus(database, userId)
}
