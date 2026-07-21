import { connectMcpHttpClient } from './mcpHttpClient.js'

export const GITHUB_MCP_SERVER = 'github'
export const DEFAULT_GITHUB_MCP_URL =
  'https://api.githubcopilot.com/mcp/'

export const GITHUB_MCP_OFFICIAL_TOOLS = Object.freeze([
  'get_me',
  'get_file_contents',
  'get_commit',
  'list_commits',
  'search_code',
  'list_issues',
  'issue_read',
  'list_pull_requests',
  'pull_request_read',
  'actions_list',
  'actions_get',
  'get_job_logs',
  'get_latest_release'
])

export function githubMcpExecutionMode(
  env = process.env
) {
  const value = String(
    env.GITHUB_MCP_MODE || 'disabled'
  ).trim().toLowerCase()

  if (
    value === 'active' ||
    value === 'on' ||
    value === 'enabled' ||
    value === '1' ||
    value === 'true'
  ) {
    return 'active'
  }

  return 'disabled'
}

export function githubMcpConfigured(
  env = process.env
) {
  const token = String(
    env.GITHUB_MCP_TOKEN || ''
  ).trim()

  return token.length >= 20
}

export function githubMcpEnabled(
  env = process.env
) {
  return (
    githubMcpExecutionMode(env) === 'active' &&
    githubMcpConfigured(env)
  )
}

function officialGitHubMcpUrl(value) {
  let url

  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error('GITHUB_MCP_URL ist ungültig')
  }

  const valid =
    url.protocol === 'https:' &&
    url.hostname === 'api.githubcopilot.com' &&
    (url.port === '' || url.port === '443') &&
    url.pathname === '/mcp/' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash

  if (!valid) {
    throw new Error(
      'GITHUB_MCP_URL muss exakt auf den offiziellen GitHub-Endpunkt zeigen'
    )
  }

  return DEFAULT_GITHUB_MCP_URL
}

export function githubMcpConfig(env = process.env) {
  const token = String(
    env.GITHUB_MCP_TOKEN || ''
  ).trim()

  if (token.length < 20) {
    throw new Error('GITHUB_MCP_TOKEN fehlt')
  }

  return {
    url: officialGitHubMcpUrl(
      env.GITHUB_MCP_URL ||
        DEFAULT_GITHUB_MCP_URL
    ),
    headers: {
      Authorization: `Bearer ${token}`,
      'X-MCP-Readonly': 'true',
      'X-MCP-Lockdown': 'true',
      'X-MCP-Tools':
        GITHUB_MCP_OFFICIAL_TOOLS.join(',')
    }
  }
}

export async function connectGitHubMcpClient({
  url,
  headers,
  name = 'echolink-github-mcp-client',
  signal
}) {
  return connectMcpHttpClient({
    url,
    headers,
    name,
    signal
  })
}
