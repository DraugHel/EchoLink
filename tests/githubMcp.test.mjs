import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  GITHUB_MCP_OFFICIAL_TOOLS,
  githubMcpConfig,
  githubMcpExecutionMode
} from '../server/lib/githubMcpClient.js'
import {
  executeGitHubTool,
  GITHUB_TOOLS,
  GITHUB_TOOL_NAMES,
  githubAllowedRepositories
} from '../server/lib/githubTools.js'
import {
  getMcpRegistrySnapshot,
  getMcpRegistryStatus,
  resetMcpRegistryForTests
} from '../server/lib/mcpRegistry.js'

const ENV = {
  GITHUB_MCP_MODE: 'active',
  GITHUB_MCP_TOKEN:
    'github_pat_test_secret_1234567890',
  GITHUB_MCP_URL:
    'https://api.githubcopilot.com/mcp/',
  GITHUB_MCP_ALLOWED_REPOS:
    'DraugHel/EchoLink',
  GITHUB_MCP_REQUEST_TIMEOUT_MS: '2500',
  GITHUB_MCP_TOOL_TIMEOUT_MS: '2200',
  GITHUB_MCP_FALLBACK_COOLDOWN_MS: '1000',
  MCP_WEB_MODE: 'direct',
  SESSION_SECRET: 'session-secret-1234567890'
}

function githubConnection({
  tools = GITHUB_MCP_OFFICIAL_TOOLS,
  onCall
} = {}) {
  return async options => ({
    options,
    client: {
      async listTools() {
        return {
          tools: tools.map(name => ({ name }))
        }
      },
      async callTool(request) {
        onCall?.(request, options)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(request)
          }]
        }
      }
    },
    async close() {}
  })
}

test.beforeEach(() => {
  resetMcpRegistryForTests()
})

test('GitHub MCP ist opt-in und erzwingt offizielle Read-only-Header', () => {
  assert.equal(githubMcpExecutionMode({}), 'disabled')
  assert.equal(
    githubMcpExecutionMode({ GITHUB_MCP_MODE: 'active' }),
    'active'
  )

  const config = githubMcpConfig(ENV)
  assert.equal(
    config.headers.Authorization,
    `Bearer ${ENV.GITHUB_MCP_TOKEN}`
  )
  assert.equal(config.headers['X-MCP-Readonly'], 'true')
  assert.equal(config.headers['X-MCP-Lockdown'], 'true')
  assert.equal(
    config.headers['X-MCP-Tools'],
    GITHUB_MCP_OFFICIAL_TOOLS.join(',')
  )

  assert.throws(
    () => githubMcpConfig({
      ...ENV,
      GITHUB_MCP_URL: 'https://example.com/mcp/'
    }),
    /offiziellen GitHub-Endpunkt/
  )

  for (const blocked of [
    'create_or_update_file',
    'issue_write',
    'create_pull_request',
    'actions_run_trigger'
  ]) {
    assert.ok(
      !GITHUB_MCP_OFFICIAL_TOOLS.includes(blocked)
    )
  }
})

test('Registry entdeckt nur kuratierte GitHub-Tools und redigiert den PAT', async () => {
  const statuses = await getMcpRegistryStatus({
    env: ENV,
    connectors: {
      github: githubConnection({
        tools: [
          ...GITHUB_MCP_OFFICIAL_TOOLS,
          'create_or_update_file'
        ]
      })
    },
    forceDiscovery: true
  })

  const server = statuses.find(
    item => item.name === 'github'
  )

  assert.ok(server)
  assert.equal(server.mode, 'active')
  assert.equal(server.configured, true)
  assert.equal(server.readOnly, true)
  assert.equal(server.reachable, true)
  assert.equal(
    server.url,
    'https://api.githubcopilot.com/mcp/'
  )
  assert.equal(server.tools.length, 13)
  assert.ok(server.tools.every(tool => tool.readOnly))
  assert.ok(
    server.tools.every(
      tool => tool.fallbackAllowed === false
    )
  )
  assert.doesNotMatch(
    JSON.stringify(server),
    /github_pat_test_secret/
  )
  assert.doesNotMatch(
    JSON.stringify(server),
    /create_or_update_file/
  )
})

test('GitHub Tool-Wrapper mappt auf offizielle Tools und begrenzt Repositories', async () => {
  let call

  const result = await executeGitHubTool(
    'github_get_file',
    {
      owner: 'DraugHel',
      repo: 'EchoLink',
      path: 'server/index.js'
    },
    {
      env: ENV,
      connectFn: githubConnection({
        onCall(request) {
          call = request
        }
      })
    }
  )

  assert.equal(call.name, 'get_file_contents')
  assert.deepEqual(call.arguments, {
    owner: 'DraugHel',
    repo: 'EchoLink',
    path: 'server/index.js'
  })
  assert.match(result, /get_file_contents/)

  await assert.rejects(
    executeGitHubTool(
      'github_get_file',
      {
        owner: 'SomebodyElse',
        repo: 'PrivateRepo'
      },
      {
        env: ENV,
        connectFn: githubConnection()
      }
    ),
    error =>
      error?.name ===
        'GitHubMcpRepositoryBlockedError'
  )
})

test('GitHub-Code-Suche wird automatisch auf EchoLink eingeschränkt', async () => {
  let call

  await executeGitHubTool(
    'github_search_code',
    { query: 'mcpRegistry' },
    {
      env: ENV,
      connectFn: githubConnection({
        onCall(request) {
          call = request
        }
      })
    }
  )

  assert.equal(call.name, 'search_code')
  assert.equal(
    call.arguments.query,
    'mcpRegistry repo:DraugHel/EchoLink'
  )

  await assert.rejects(
    executeGitHubTool(
      'github_search_code',
      { query: 'secret repo:Other/Repo' },
      {
        env: ENV,
        connectFn: githubConnection()
      }
    ),
    error =>
      error?.name ===
        'GitHubMcpRepositoryBlockedError'
  )
})

test('Job-Logs verlangen eine eindeutige read-only Auswahl', async () => {
  await assert.rejects(
    executeGitHubTool(
      'github_get_job_logs',
      {
        owner: 'DraugHel',
        repo: 'EchoLink'
      },
      {
        env: ENV,
        connectFn: githubConnection()
      }
    ),
    /job_id oder failed_only=true/
  )
})

test('EchoLink exportiert ausschließlich read-only GitHub-Wrapper', () => {
  assert.equal(GITHUB_TOOLS.length, 13)
  assert.equal(GITHUB_TOOL_NAMES.size, 13)
  assert.deepEqual(
    githubAllowedRepositories(ENV),
    ['DraugHel/EchoLink']
  )

  const names = GITHUB_TOOLS.map(
    tool => tool.function.name
  )

  for (const name of [
    'github_get_file',
    'github_get_commit',
    'github_get_issue',
    'github_get_pull_request',
    'github_get_job_logs'
  ]) {
    assert.ok(names.includes(name))
  }

  assert.ok(
    names.every(name => !/create|update|delete|write|merge|trigger/.test(name))
  )
})

test('Chat, Agent, Tool-Registry und Deploy sind verdrahtet', async () => {
  const [
    chat,
    agent,
    registry,
    deploy,
    envExample,
    configureScript
  ] =
    await Promise.all([
      readFile(
        new URL('../server/routes/chat.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../server/lib/agentRunner.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../server/lib/toolRegistry.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../scripts/deploy.sh', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../.env.example', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../scripts/configure-github-mcp.sh', import.meta.url),
        'utf8'
      )
    ])

  assert.match(chat, /GITHUB_TOOL_NAMES\.has\(name\)/)
  assert.match(chat, /source: 'chat'/)
  assert.match(agent, /githubMcpEnabled\(\) \? GITHUB_TOOLS/)
  assert.match(agent, /source: 'scheduled-agent'/)
  assert.match(registry, /githubMcpEnabled\(\) \? GITHUB_TOOLS/)
  assert.match(deploy, /mcp-github-smoke\.js/)
  assert.match(envExample, /GITHUB_MCP_MODE=disabled/)
  assert.match(
    envExample,
    /GITHUB_MCP_ALLOWED_REPOS=DraugHel\/EchoLink/
  )
  assert.match(configureScript, /read -r -s TOKEN/)
  assert.doesNotMatch(configureScript, /echo \"\$TOKEN/)
})

test('GitHub-Registry zählt erfolgreiche Aufrufe ohne Fallback', async () => {
  await executeGitHubTool(
    'github_profile',
    {},
    {
      env: ENV,
      connectFn: githubConnection()
    }
  )

  const server = getMcpRegistrySnapshot({
    env: ENV
  }).find(item => item.name === 'github')

  assert.equal(server.successCount, 1)
  assert.equal(server.errorCount, 0)
  assert.equal(server.fallbackCount, 0)
  assert.equal(server.circuitBreaker.state, 'closed')
})
