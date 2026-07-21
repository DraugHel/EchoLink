import { connectMcpHttpClient } from './mcpHttpClient.js'

export function mcpWebConfig(env = process.env) {
  const token =
    env.MCP_WEB_TOKEN ||
    env.SESSION_SECRET

  if (!token || String(token).length < 16) {
    throw new Error(
      'MCP_WEB_TOKEN oder SESSION_SECRET fehlt'
    )
  }

  return {
    url:
      env.MCP_WEB_URL ||
      'http://127.0.0.1:3011/mcp',
    headers: {
      Authorization: `Bearer ${token}`
    }
  }
}

export async function connectMcpWebClient({
  url,
  headers,
  name = 'echolink-mcp-web-client',
  signal
}) {
  return connectMcpHttpClient({
    url,
    headers,
    name,
    signal
  })
}
