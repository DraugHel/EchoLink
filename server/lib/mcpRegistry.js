import {
  connectMcpWebClient,
  mcpWebConfig
} from './mcpWebClient.js'
import {
  connectGitHubMcpClient,
  githubMcpConfig,
  githubMcpConfigured,
  githubMcpExecutionMode,
  GITHUB_MCP_OFFICIAL_TOOLS,
  GITHUB_MCP_SERVER
} from './githubMcpClient.js'
import {
  connectPlaywrightMcpClient,
  playwrightMcpConfig,
  playwrightMcpConfigured,
  playwrightMcpExecutionMode,
  PLAYWRIGHT_MCP_SERVER,
  PLAYWRIGHT_MCP_TOOL_SPECS
} from './playwrightMcpClient.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_FALLBACK_COOLDOWN_MS = 15_000
const DEFAULT_DISCOVERY_CACHE_MS = 10_000
const MCP_WEB_SERVER = 'mcp-web'

function toolDefinition({
  timeoutEnv,
  fallbackAllowed = false,
  readOnly = true
}) {
  return Object.freeze({
    enabled: true,
    readOnly,
    fallbackAllowed,
    timeoutEnv
  })
}

const githubTools = Object.fromEntries(
  GITHUB_MCP_OFFICIAL_TOOLS.map(name => [
    name,
    toolDefinition({
      timeoutEnv: 'GITHUB_MCP_TOOL_TIMEOUT_MS'
    })
  ])
)

const playwrightTools = Object.fromEntries(
  PLAYWRIGHT_MCP_TOOL_SPECS.map(tool => [
    tool.name,
    toolDefinition({
      timeoutEnv:
        'MCP_PLAYWRIGHT_TOOL_TIMEOUT_MS',
      readOnly: tool.readOnly
    })
  ])
)

const SERVER_DEFINITIONS = Object.freeze({
  [MCP_WEB_SERVER]: Object.freeze({
    id: MCP_WEB_SERVER,
    name: 'mcp-web',
    urlEnv: 'MCP_WEB_URL',
    defaultUrl: 'http://127.0.0.1:3011/mcp',
    mode: mcpWebExecutionMode,
    configured: () => true,
    notConfiguredMessage:
      'Nicht konfiguriert',
    connectionConfig: mcpWebConfig,
    connect: connectMcpWebClient,
    requestTimeoutEnv: 'MCP_WEB_REQUEST_TIMEOUT_MS',
    fallbackCooldownEnv:
      'MCP_WEB_FALLBACK_COOLDOWN_MS',
    tools: Object.freeze({
      web_search: toolDefinition({
        timeoutEnv: 'MCP_WEB_SEARCH_TIMEOUT_MS',
        fallbackAllowed: true
      }),
      firecrawl_scrape: toolDefinition({
        timeoutEnv: 'MCP_WEB_SCRAPE_TIMEOUT_MS',
        fallbackAllowed: true
      })
    })
  }),
  [GITHUB_MCP_SERVER]: Object.freeze({
    id: GITHUB_MCP_SERVER,
    name: 'github',
    urlEnv: 'GITHUB_MCP_URL',
    defaultUrl:
      'https://api.githubcopilot.com/mcp/',
    mode: githubMcpExecutionMode,
    configured: githubMcpConfigured,
    notConfiguredMessage:
      'Nicht konfiguriert: Zugangstoken fehlt',
    connectionConfig: githubMcpConfig,
    connect: connectGitHubMcpClient,
    requestTimeoutEnv:
      'GITHUB_MCP_REQUEST_TIMEOUT_MS',
    fallbackCooldownEnv:
      'GITHUB_MCP_FALLBACK_COOLDOWN_MS',
    tools: Object.freeze(githubTools)
  }),
  [PLAYWRIGHT_MCP_SERVER]: Object.freeze({
    id: PLAYWRIGHT_MCP_SERVER,
    name: 'playwright',
    urlEnv: 'MCP_PLAYWRIGHT_URL',
    defaultUrl: 'http://127.0.0.1:3012/mcp',
    mode: playwrightMcpExecutionMode,
    configured: playwrightMcpConfigured,
    notConfiguredMessage:
      'Nicht konfiguriert: lokale URL oder Origin-Allowlist ungültig',
    connectionConfig: playwrightMcpConfig,
    connect: connectPlaywrightMcpClient,
    requestTimeoutEnv:
      'MCP_PLAYWRIGHT_REQUEST_TIMEOUT_MS',
    fallbackCooldownEnv:
      'MCP_PLAYWRIGHT_FALLBACK_COOLDOWN_MS',
    tools: Object.freeze(playwrightTools)
  })
})

const registryState = new Map()

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback
}

function stateFor(serverId) {
  if (!registryState.has(serverId)) {
    registryState.set(serverId, {
      reachable: null,
      lastSuccessfulConnection: null,
      lastError: null,
      latencyMs: null,
      successCount: 0,
      errorCount: 0,
      fallbackCount: 0,
      discoveredTools: [],
      lastDiscoveryAt: 0,
      circuitOpenUntil: 0,
      discoveryPromise: null
    })
  }

  return registryState.get(serverId)
}

function definitionFor(serverId) {
  const definition = SERVER_DEFINITIONS[serverId]

  if (!definition) {
    const error = new Error(
      `Unbekannter MCP-Server: ${serverId}`
    )
    error.name = 'McpRegistryServerBlockedError'
    throw error
  }

  return definition
}

export function mcpWebExecutionMode(
  env = process.env
) {
  const value = String(
    env.MCP_WEB_MODE || 'active'
  ).trim().toLowerCase()

  if (
    value === 'direct' ||
    value === 'off' ||
    value === 'disabled' ||
    value === '0' ||
    value === 'false' ||
    value === 'shadow'
  ) {
    return 'direct'
  }

  return 'active'
}

function serverConfig(serverId, env = process.env) {
  const definition = definitionFor(serverId)
  const requestTimeoutMs = positiveInteger(
    env[definition.requestTimeoutEnv],
    DEFAULT_REQUEST_TIMEOUT_MS
  )
  const fallbackCooldownMs = positiveInteger(
    env[definition.fallbackCooldownEnv],
    DEFAULT_FALLBACK_COOLDOWN_MS
  )
  const mode = definition.mode(env)
  const configured = definition.configured(env)
  const tools = Object.entries(definition.tools)
    .map(([name, tool]) => ({
      name,
      enabled: tool.enabled,
      readOnly: tool.readOnly,
      fallbackAllowed: tool.fallbackAllowed,
      timeoutMs: positiveInteger(
        env[tool.timeoutEnv],
        requestTimeoutMs
      )
    }))

  return {
    id: definition.id,
    name: definition.name,
    mode,
    configured,
    readOnly: tools.every(tool => tool.readOnly),
    url: String(
      env[definition.urlEnv] ||
      definition.defaultUrl
    ),
    notConfiguredMessage:
      definition.notConfiguredMessage,
    requestTimeoutMs,
    fallbackCooldownMs,
    discoveryCacheMs: positiveInteger(
      env.MCP_REGISTRY_DISCOVERY_CACHE_MS,
      DEFAULT_DISCOVERY_CACHE_MS
    ),
    tools
  }
}

function publicUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return 'ungültige URL'
  }
}

function secretValues(env) {
  return [
    env?.MCP_WEB_TOKEN,
    env?.GITHUB_MCP_TOKEN,
    env?.SESSION_SECRET
  ]
    .map(value => String(value || '').trim())
    .filter(value => value.length >= 8)
}

export function sanitizeMcpError(
  error,
  env = process.env
) {
  let text = String(
    error?.message || error || 'Unbekannter MCP-Fehler'
  )

  for (const secret of secretValues(env)) {
    text = text.split(secret).join('[redacted]')
  }

  text = text
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|authorization)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, match => {
      const protocol = match.startsWith('https://')
        ? 'https://'
        : 'http://'
      return protocol
    })

  return text.slice(0, 500)
}

function structuredLog(level, event, fields = {}) {
  const entry = {
    level,
    event,
    ...fields
  }

  const output = JSON.stringify(entry)

  if (level === 'error') {
    console.error(output)
  } else if (level === 'warn') {
    console.warn(output)
  } else {
    console.log(output)
  }
}

function abortError() {
  const error = new Error('MCP tool request aborted')
  error.name = 'AbortError'
  return error
}

function linkedAbortSignal(externalSignal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason)
  }

  if (externalSignal?.aborted) {
    onExternalAbort()
  } else {
    externalSignal?.addEventListener(
      'abort',
      onExternalAbort,
      { once: true }
    )
  }

  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(
      new Error('MCP request timed out')
    )
  }, timeoutMs)

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timeout)
      externalSignal?.removeEventListener(
        'abort',
        onExternalAbort
      )
    }
  }
}

function isoTime(value) {
  return new Date(value).toISOString()
}

function latency(startedAt, endedAt) {
  return Math.max(
    0,
    Math.round(endedAt - startedAt)
  )
}

function updateDiscovery(
  state,
  names,
  startedAt,
  endedAt
) {
  state.reachable = true
  state.lastSuccessfulConnection = isoTime(endedAt)
  state.lastError = null
  state.latencyMs = latency(startedAt, endedAt)
  state.discoveredTools = [...new Set(names)].sort()
  state.lastDiscoveryAt = endedAt
}

function knownToolNames(config) {
  return new Set(config.tools.map(tool => tool.name))
}

function discoveredToolNames(listed) {
  return (listed?.tools || [])
    .map(tool => String(tool?.name || '').trim())
    .filter(Boolean)
}

function publicStatus(
  serverId,
  env = process.env,
  nowValue = Date.now()
) {
  const config = serverConfig(serverId, env)
  const state = stateFor(serverId)
  const discovered = new Set(state.discoveredTools)
  const circuitOpen = nowValue < state.circuitOpenUntil

  return {
    name: config.name,
    url: publicUrl(config.url),
    mode: config.mode,
    configured: config.configured,
    readOnly: config.readOnly,
    reachable: state.reachable,
    lastSuccessfulConnection:
      state.lastSuccessfulConnection,
    lastError: state.lastError,
    latencyMs: state.latencyMs,
    successCount: state.successCount,
    errorCount: state.errorCount,
    fallbackCount: state.fallbackCount,
    circuitBreaker: {
      state: circuitOpen ? 'open' : 'closed',
      openUntil: circuitOpen
        ? isoTime(state.circuitOpenUntil)
        : null,
      cooldownMs: config.fallbackCooldownMs
    },
    tools: config.tools.map(tool => ({
      name: tool.name,
      enabled: tool.enabled,
      discovered: discovered.has(tool.name),
      timeoutMs: tool.timeoutMs,
      readOnly: tool.readOnly,
      fallbackAllowed: tool.fallbackAllowed
    }))
  }
}

function connectorFor(serverId, connectFn, connectors) {
  if (connectors?.[serverId]) {
    return connectors[serverId]
  }

  if (connectFn) return connectFn

  return definitionFor(serverId).connect
}

async function listKnownTools(
  connection,
  config,
  linked,
  timeoutMs
) {
  const listed = await connection.client.listTools(
    undefined,
    {
      signal: linked.signal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs
    }
  )
  const allNames = discoveredToolNames(listed)
  const knownNames = knownToolNames(config)
  const unknown = allNames.filter(
    name => !knownNames.has(name)
  )

  if (unknown.length > 0) {
    structuredLog(
      'warn',
      'mcp_registry_unknown_tools_blocked',
      {
        server: config.name,
        tools: unknown.slice(0, 20)
      }
    )
  }

  return allNames.filter(name => knownNames.has(name))
}

export async function discoverMcpServer(
  serverId,
  {
    env = process.env,
    connectFn,
    connectors,
    signal,
    force = false,
    now = Date.now
  } = {}
) {
  const definition = definitionFor(serverId)
  const config = serverConfig(serverId, env)
  const state = stateFor(serverId)
  const nowValue = now()

  if (config.mode !== 'active') {
    state.reachable = null
    state.lastError = null
    state.discoveredTools = []
    state.lastDiscoveryAt = 0
    state.circuitOpenUntil = 0
    return publicStatus(serverId, env, nowValue)
  }

  if (!config.configured) {
    state.reachable = false
    state.lastError = config.notConfiguredMessage
    state.discoveredTools = []
    return publicStatus(serverId, env, nowValue)
  }

  if (
    !force &&
    state.lastDiscoveryAt > 0 &&
    nowValue - state.lastDiscoveryAt <
      config.discoveryCacheMs
  ) {
    return publicStatus(serverId, env, nowValue)
  }

  if (state.discoveryPromise) {
    await state.discoveryPromise
    return publicStatus(serverId, env, now())
  }

  state.discoveryPromise = (async () => {
    const startedAt = now()
    const linked = linkedAbortSignal(
      signal,
      config.requestTimeoutMs
    )
    let connection

    try {
      const connectionConfig =
        definition.connectionConfig(env)
      const connector = connectorFor(
        serverId,
        connectFn,
        connectors
      )
      connection = await connector({
        ...connectionConfig,
        name: `echolink-${serverId}-registry`,
        signal: linked.signal
      })
      const names = await listKnownTools(
        connection,
        config,
        linked,
        config.requestTimeoutMs
      )
      const endedAt = now()

      updateDiscovery(
        state,
        names,
        startedAt,
        endedAt
      )

      structuredLog(
        'info',
        'mcp_registry_discovery_completed',
        {
          server: config.name,
          reachable: true,
          latencyMs: state.latencyMs,
          tools: names
        }
      )
    } catch (error) {
      if (signal?.aborted) throw abortError()

      const endedAt = now()
      const message = linked.timedOut()
        ? `MCP discovery timed out after ${config.requestTimeoutMs} ms`
        : sanitizeMcpError(error, env)

      state.reachable = false
      state.lastError = message
      state.latencyMs = latency(startedAt, endedAt)
      state.lastDiscoveryAt = endedAt
      state.errorCount += 1

      structuredLog(
        'warn',
        'mcp_registry_discovery_failed',
        {
          server: config.name,
          latencyMs: state.latencyMs,
          error: message
        }
      )
    } finally {
      linked.cleanup()
      await connection?.close?.().catch(() => {})
    }
  })()

  try {
    await state.discoveryPromise
  } finally {
    state.discoveryPromise = null
  }

  return publicStatus(serverId, env, now())
}

export async function getMcpRegistryStatus({
  env = process.env,
  connectFn,
  connectors,
  signal,
  forceDiscovery = false,
  now = Date.now
} = {}) {
  const statuses = []

  for (const serverId of Object.keys(SERVER_DEFINITIONS)) {
    try {
      statuses.push(await discoverMcpServer(
        serverId,
        {
          env,
          connectFn,
          connectors,
          signal,
          force: forceDiscovery,
          now
        }
      ))
    } catch (error) {
      if (signal?.aborted) throw abortError()

      const state = stateFor(serverId)
      state.reachable = false
      state.lastError = sanitizeMcpError(error, env)
      statuses.push(publicStatus(
        serverId,
        env,
        now()
      ))
    }
  }

  return statuses
}

export function mcpRegistryToolConfig(
  serverId,
  toolName,
  env = process.env
) {
  const config = serverConfig(serverId, env)
  const tool = config.tools.find(
    item => item.name === toolName
  )

  if (!tool) {
    const error = new Error(
      `Unbekanntes MCP-Tool blockiert: ${toolName}`
    )
    error.name = 'McpRegistryToolBlockedError'
    throw error
  }

  if (!tool.enabled) {
    const error = new Error(
      `Deaktiviertes MCP-Tool blockiert: ${toolName}`
    )
    error.name = 'McpRegistryToolBlockedError'
    throw error
  }

  return {
    ...tool,
    mode: config.mode,
    fallbackCooldownMs: config.fallbackCooldownMs
  }
}

export function isMcpCircuitOpen(
  serverId,
  {
    env = process.env,
    now = Date.now
  } = {}
) {
  definitionFor(serverId)
  const state = stateFor(serverId)
  const open = now() < state.circuitOpenUntil

  if (!open && state.circuitOpenUntil > 0) {
    state.circuitOpenUntil = 0
  }

  return open
}

export async function executeMcpRegistryTool(
  serverId,
  toolName,
  args,
  {
    env = process.env,
    connectFn,
    connectors,
    getConnection,
    signal,
    source = 'unknown',
    now = Date.now
  } = {}
) {
  const definition = definitionFor(serverId)
  const config = serverConfig(serverId, env)
  const tool = mcpRegistryToolConfig(
    serverId,
    toolName,
    env
  )
  const state = stateFor(serverId)

  if (config.mode !== 'active') {
    const error = new Error(
      `MCP-Server ist nicht aktiv: ${serverId}`
    )
    error.name = 'McpRegistryServerDisabledError'
    throw error
  }

  if (!config.configured) {
    const error = new Error(
      `MCP-Server ist nicht konfiguriert: ${serverId}`
    )
    error.name = 'McpRegistryServerNotConfiguredError'
    throw error
  }

  if (signal?.aborted) throw abortError()

  if (isMcpCircuitOpen(serverId, { env, now })) {
    const error = new Error(
      `MCP circuit breaker is open for ${serverId}`
    )
    error.name = 'McpRegistryCircuitOpenError'
    throw error
  }

  const startedAt = now()
  const linked = linkedAbortSignal(
    signal,
    tool.timeoutMs
  )
  let connection
  const retainedConnection =
    typeof getConnection === 'function'

  try {
    const connectionConfig =
      definition.connectionConfig(env)
    const connector = connectorFor(
      serverId,
      connectFn,
      connectors
    )
    const openConnection = () => connector({
      ...connectionConfig,
      name: `echolink-${serverId}-${toolName}`,
      signal: linked.signal
    })

    connection = retainedConnection
      ? await getConnection(openConnection)
      : await openConnection()

    if (
      state.discoveredTools.length === 0 ||
      now() - state.lastDiscoveryAt >=
        config.discoveryCacheMs
    ) {
      const names = await listKnownTools(
        connection,
        config,
        linked,
        tool.timeoutMs
      )
      updateDiscovery(
        state,
        names,
        startedAt,
        now()
      )
    }

    if (!state.discoveredTools.includes(toolName)) {
      const error = new Error(
        `MCP-Tool nicht vom Server angeboten: ${toolName}`
      )
      error.name = 'McpRegistryToolUnavailableError'
      throw error
    }

    const result = await connection.client.callTool(
      {
        name: toolName,
        arguments: args
      },
      undefined,
      {
        signal: linked.signal,
        timeout: tool.timeoutMs,
        maxTotalTimeout: tool.timeoutMs
      }
    )
    const endedAt = now()

    state.reachable = true
    state.lastSuccessfulConnection = isoTime(endedAt)
    state.lastError = null
    state.latencyMs = latency(startedAt, endedAt)
    state.successCount += 1
    state.circuitOpenUntil = 0

    structuredLog(
      'info',
      'mcp_registry_tool_completed',
      {
        server: config.name,
        tool: toolName,
        source,
        latencyMs: state.latencyMs
      }
    )

    return result
  } catch (error) {
    if (signal?.aborted) throw abortError()

    const endedAt = now()
    const message = linked.timedOut()
      ? `MCP ${toolName} timed out after ${tool.timeoutMs} ms`
      : sanitizeMcpError(error, env)

    state.reachable = false
    state.lastError = message
    state.latencyMs = latency(startedAt, endedAt)
    state.errorCount += 1
    state.circuitOpenUntil =
      endedAt + config.fallbackCooldownMs

    structuredLog(
      'warn',
      'mcp_registry_tool_failed',
      {
        server: config.name,
        tool: toolName,
        source,
        latencyMs: state.latencyMs,
        error: message,
        circuitOpenUntil:
          isoTime(state.circuitOpenUntil)
      }
    )

    const wrapped = new Error(message)
    wrapped.name = linked.timedOut()
      ? 'McpRegistryTimeoutError'
      : 'McpRegistryError'
    throw wrapped
  } finally {
    linked.cleanup()
    if (!retainedConnection) {
      await connection?.close?.().catch(() => {})
    }
  }
}

export function recordMcpFallback(
  serverId,
  toolName,
  {
    source = 'unknown',
    reason,
    error,
    env = process.env
  } = {}
) {
  const tool = mcpRegistryToolConfig(
    serverId,
    toolName,
    env
  )

  if (!tool.fallbackAllowed) {
    const blocked = new Error(
      `Fallback für MCP-Tool blockiert: ${toolName}`
    )
    blocked.name = 'McpRegistryFallbackBlockedError'
    throw blocked
  }

  const state = stateFor(serverId)
  state.fallbackCount += 1

  structuredLog(
    'warn',
    'mcp_registry_fallback',
    {
      server: serverId,
      tool: toolName,
      source,
      reason,
      error: sanitizeMcpError(error, env)
    }
  )
}

export function getMcpRegistrySnapshot({
  env = process.env,
  now = Date.now
} = {}) {
  return Object.keys(SERVER_DEFINITIONS).map(
    serverId => publicStatus(
      serverId,
      env,
      now()
    )
  )
}

export function resetMcpRegistryForTests() {
  registryState.clear()
}
