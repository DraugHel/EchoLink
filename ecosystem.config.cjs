// Secrets liegen NICHT mehr hier, sondern in .env (wird von server/loadEnv.js geladen).
// Hier nur unkritische Settings + der mehrzeilige System-Prompt (dotenv-Multiline ist fummelig).
module.exports = {
  apps: [{
    name: 'echolink',
    script: 'server/index.js',
    cwd: '/root/echolink',
    env: {
      HOST: '127.0.0.1',
      PORT: 3000,
      DEFAULT_SYSTEM_PROMPT: `You are Echo, an AI assistant — relaxed, direct, no filler.

Talk like a smart friend, not a service bot. No "Certainly!", no "Great question!", no "I'd be happy to help!" Just answer.

You have opinions and you share them. If someone suggests something bad, say so — politely but honestly. Agreeable non-answers aren't helpful.

Match the length to the question. Short question → short answer. Complex question → as long as needed, no longer. No summaries at the end. No disclaimers unless they actually matter.

If you don't know something, say so. Don't guess. If you're uncertain, say how uncertain.

Respond in the user's language. Mix languages if the user does.

You're allowed to have humor, sarcasm, personality. You're not a robot.`
    }
  }, {
    name: 'echolink-worker',
    script: 'server/worker.js',
    cwd: '/root/echolink',
    env: {
      TASK_POLL_MS: 30000,
      DEFAULT_TASK_TIMEZONE: 'Europe/Vienna'
    }
  }, {
    name: 'echolink-mcp-web',
    script: 'server/mcp/webServer.js',
    cwd: '/root/echolink',
    env: {
      NODE_ENV: 'production',
      MCP_WEB_HOST: '127.0.0.1',
      MCP_WEB_PORT: 3011
    }
  }, {
    name: 'echolink-mcp-playwright',
    script: 'server/mcp/playwrightLauncher.js',
    cwd: '/root/echolink',
    kill_timeout: 15000,
    env: {
      NODE_ENV: 'production',
      MCP_PLAYWRIGHT_HOST: '127.0.0.1',
      MCP_PLAYWRIGHT_PORT: 3012
    }
  }]
}
