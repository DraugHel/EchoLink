import crypto from 'node:crypto'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as z from 'zod/v4'

import {
  firecrawlScrape,
  webSearch
} from '../lib/webSearch.js'
import { assertPublicHttpUrl } from './publicUrl.js'

const SERVER_NAME = 'echolink-mcp-web'
const SERVER_VERSION = '1.0.0'
const JSON_RPC_ERROR = {
  jsonrpc: '2.0',
  error: {
    code: -32000,
    message: 'Method not allowed'
  },
  id: null
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))

  return Boolean(
    a.length === b.length &&
    a.length > 0 &&
    crypto.timingSafeEqual(a, b)
  )
}

function requestHostAllowed(req) {
  const rawHost = String(req.headers.host || '')
  const hostname = rawHost
    .replace(/^\[|\]$/g, '')
    .split(':')[0]
    .toLowerCase()

  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost'
  )
}

function requestOriginAllowed(req) {
  const origin = req.headers.origin

  if (!origin) return true

  try {
    const parsed = new URL(origin)

    return (
      (parsed.protocol === 'http:' ||
        parsed.protocol === 'https:') &&
      (
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost'
      )
    )
  } catch {
    return false
  }
}

function authMiddleware(expectedToken) {
  return (req, res, next) => {
    if (!requestHostAllowed(req)) {
      return res.status(403).json({
        error: 'MCP host not allowed'
      })
    }

    if (!requestOriginAllowed(req)) {
      return res.status(403).json({
        error: 'MCP origin not allowed'
      })
    }

    const authorization = String(
      req.headers.authorization || ''
    )

    const provided = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : ''

    if (!safeEqual(provided, expectedToken)) {
      res.setHeader(
        'WWW-Authenticate',
        'Bearer realm="echolink-mcp-web"'
      )

      return res.status(401).json({
        error: 'MCP authentication required'
      })
    }

    next()
  }
}

function toolText(text, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: String(text || '')
      }
    ],
    ...(isError ? { isError: true } : {})
  }
}

function createWebMcpServer({
  webSearchFn,
  firecrawlFn,
  publicUrlCheck
}) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  })

  server.registerTool(
    'web_search',
    {
      title: 'Websuche',
      description:
        'Search the public web for current information using EchoLink\'s self-hosted SearXNG service.',
      inputSchema: {
        query: z.string()
          .trim()
          .min(1)
          .max(500)
          .describe('Specific and concise search query')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ query }, extra) => {
      const result = await webSearchFn(
        query,
        extra.signal
      )

      if (result.error) {
        return toolText(
          `Search error: ${result.error}`,
          true
        )
      }

      const text = (result.results || [])
        .map((item, index) => [
          `[${index + 1}] ${item.title}`,
          item.snippet,
          `Source: ${item.source}`
        ].filter(Boolean).join('\n'))
        .join('\n\n')

      return toolText(text || 'No results found')
    }
  )

  server.registerTool(
    'firecrawl_scrape',
    {
      title: 'Webseite lesen',
      description:
        'Fetch and read a public webpage using EchoLink\'s self-hosted Firecrawl service.',
      inputSchema: {
        url: z.string()
          .trim()
          .min(1)
          .max(2_000)
          .describe('Public HTTP or HTTPS URL')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ url }, extra) => {
      let safeUrl

      try {
        safeUrl = await publicUrlCheck(url)
      } catch (error) {
        return toolText(
          `Scrape blocked: ${error.message}`,
          true
        )
      }

      const result = await firecrawlFn(
        safeUrl,
        extra.signal
      )

      if (result.error) {
        return toolText(
          `Scrape error: ${result.error}`,
          true
        )
      }

      return toolText(
        `Content from ${safeUrl}:\n\n${result.content || ''}`
      )
    }
  )

  return server
}

export function createMcpWebApp({
  token,
  webSearchFn = webSearch,
  firecrawlFn = firecrawlScrape,
  publicUrlCheck = assertPublicHttpUrl
} = {}) {
  if (!token || String(token).length < 16) {
    throw new Error(
      'MCP_WEB_TOKEN oder SESSION_SECRET muss mindestens 16 Zeichen lang sein'
    )
  }

  const app = express()
  const requireMcpAuth = authMiddleware(token)

  app.disable('x-powered-by')
  app.use(express.json({ limit: '256kb' }))

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'streamable-http',
      mode: 'shadow'
    })
  })

  app.post(
    '/mcp',
    requireMcpAuth,
    async (req, res) => {
      const server = createWebMcpServer({
        webSearchFn,
        firecrawlFn,
        publicUrlCheck
      })

      const transport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        })

      let cleaned = false

      const cleanup = async () => {
        if (cleaned) return
        cleaned = true

        await Promise.allSettled([
          transport.close(),
          server.close()
        ])
      }

      res.once('close', cleanup)

      try {
        await server.connect(transport)
        await transport.handleRequest(
          req,
          res,
          req.body
        )
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'mcp_web_request_failed',
          error: error?.message || String(error)
        }))

        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal MCP server error'
            },
            id: null
          })
        }
      }
    }
  )

  app.get('/mcp', requireMcpAuth, (req, res) => {
    res.status(405).json(JSON_RPC_ERROR)
  })

  app.delete('/mcp', requireMcpAuth, (req, res) => {
    res.status(405).json(JSON_RPC_ERROR)
  })

  return app
}
