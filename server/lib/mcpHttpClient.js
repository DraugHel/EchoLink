import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export async function connectMcpHttpClient({
  url,
  headers = {},
  name = 'echolink-mcp-http-client',
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
          headers,
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
