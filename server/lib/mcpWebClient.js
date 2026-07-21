import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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
    token
  }
}

export async function connectMcpWebClient({
  url,
  token,
  name = 'echolink-mcp-web-client',
  signal
}) {
  const client = new Client({
    name,
    version: '1.0.0'
  })

  const transport =
    new StreamableHTTPClientTransport(
      new URL(url),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`
          },
          ...(signal ? { signal } : {})
        }
      }
    )

  await client.connect(transport)

  return {
    client,
    transport,
    async close() {
      await client.close()
    }
  }
}
