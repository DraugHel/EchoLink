import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  evaluateRuntimeSmoke
} from '../scripts/mcp-web-runtime-smoke.js'

test('erfolgreicher erwarteter Runtime-Backend-Pfad wird akzeptiert', () => {
  assert.deepEqual(
    evaluateRuntimeSmoke(
      {
        backend: 'mcp',
        fallback: false,
        error: false
      },
      {
        expectedBackend: 'mcp',
        allowToolError: true
      }
    ),
    {
      accepted: true,
      backendMatches: true,
      toolErrorTolerated: false
    }
  )
})

test('Toolfehler darf nur auf dem bestätigten Backend ohne Fallback warnen', () => {
  assert.deepEqual(
    evaluateRuntimeSmoke(
      {
        backend: 'mcp',
        fallback: false,
        error: true
      },
      {
        expectedBackend: 'mcp',
        allowToolError: true
      }
    ),
    {
      accepted: true,
      backendMatches: true,
      toolErrorTolerated: true
    }
  )

  for (const result of [
    {
      backend: 'direct',
      fallback: true,
      error: false
    },
    {
      backend: 'direct',
      fallback: true,
      error: true
    },
    {
      backend: 'mcp',
      fallback: false,
      error: true
    }
  ]) {
    const evaluation = evaluateRuntimeSmoke(
      result,
      {
        expectedBackend: 'mcp',
        allowToolError:
          result.backend !== 'mcp' ||
          result.error
      }
    )

    if (
      result.backend === 'mcp' &&
      result.fallback === false
    ) {
      assert.equal(evaluation.accepted, true)
    } else {
      assert.equal(evaluation.accepted, false)
    }
  }
})

test('Toolfehler bleibt ohne explizite Deploy-Ausnahme fatal', () => {
  const evaluation = evaluateRuntimeSmoke(
    {
      backend: 'mcp',
      fallback: false,
      error: true
    },
    {
      expectedBackend: 'mcp',
      allowToolError: false
    }
  )

  assert.equal(evaluation.accepted, false)
  assert.equal(evaluation.toolErrorTolerated, false)
})

test('Deploy erlaubt nur Toolfehler, nicht Backend-Fallbacks', async () => {
  const deploy = await readFile(
    new URL('../scripts/deploy.sh', import.meta.url),
    'utf8'
  )

  assert.match(
    deploy,
    /mcp-web-runtime-smoke\.js[\s\S]*--expect-backend=mcp[\s\S]*--allow-tool-error/
  )
  assert.match(
    deploy,
    /mcp-web-runtime-smoke\.js[\s\S]*--expect-backend=direct[\s\S]*--allow-tool-error/
  )
})
