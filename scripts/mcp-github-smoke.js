import '../server/loadEnv.js'
import {
  discoverMcpServer,
  executeMcpRegistryTool
} from '../server/lib/mcpRegistry.js'
import {
  GITHUB_MCP_SERVER,
  githubMcpExecutionMode
} from '../server/lib/githubMcpClient.js'
import {
  githubAllowedRepositories
} from '../server/lib/githubTools.js'

const mode = githubMcpExecutionMode()

if (mode !== 'active') {
  console.log(JSON.stringify({
    ok: true,
    event: 'github_mcp_smoke_skipped',
    mode
  }))
  process.exit(0)
}

const status = await discoverMcpServer(
  GITHUB_MCP_SERVER,
  { force: true }
)

if (!status.configured || !status.reachable) {
  throw new Error(
    status.lastError ||
    'GitHub MCP ist nicht erreichbar'
  )
}

const profile = await executeMcpRegistryTool(
  GITHUB_MCP_SERVER,
  'get_me',
  {},
  { source: 'github-mcp-smoke' }
)

const [repository] = githubAllowedRepositories()

if (repository) {
  const [owner, repo] = repository.split('/')

  await executeMcpRegistryTool(
    GITHUB_MCP_SERVER,
    'get_file_contents',
    { owner, repo, path: '' },
    { source: 'github-mcp-smoke' }
  )
}

console.log(JSON.stringify({
  ok: true,
  event: 'github_mcp_smoke_completed',
  server: status.name,
  mode: status.mode,
  readOnly: status.readOnly,
  repository: repository || null,
  toolCount: status.tools.filter(
    tool => tool.discovered
  ).length,
  profileContentItems:
    Array.isArray(profile?.content)
      ? profile.content.length
      : 0
}))
