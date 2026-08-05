import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chatToolIterationLimit,
  scheduledAgentTimeoutMs,
  scheduledAgentToolCallLimit,
  scheduledAgentToolIterationLimit
} from '../server/lib/toolLimits.js'

test('tool budgets default to 500 and one hour', () => {
  assert.equal(chatToolIterationLimit({}), 500)
  assert.equal(scheduledAgentToolIterationLimit({}), 500)
  assert.equal(scheduledAgentToolCallLimit({}), 500)
  assert.equal(scheduledAgentTimeoutMs({}), 3_600_000)
})

test('tool budgets accept explicit values and cap extreme input', () => {
  const env = {
    CHAT_MAX_TOOL_ITERATIONS: '900',
    SCHEDULED_AGENT_MAX_TOOL_ITERATIONS: '800',
    SCHEDULED_AGENT_MAX_TOOL_CALLS: '700',
    SCHEDULED_AGENT_TIMEOUT_MS: '7200000'
  }
  assert.equal(chatToolIterationLimit(env), 900)
  assert.equal(scheduledAgentToolIterationLimit(env), 800)
  assert.equal(scheduledAgentToolCallLimit(env), 700)
  assert.equal(scheduledAgentTimeoutMs(env), 7_200_000)

  assert.equal(
    chatToolIterationLimit({
      CHAT_MAX_TOOL_ITERATIONS: '999999'
    }),
    2000
  )
  assert.equal(
    scheduledAgentTimeoutMs({
      SCHEDULED_AGENT_TIMEOUT_MS: '999999999'
    }),
    21_600_000
  )
})

test('invalid tool budget values fail to safe defaults', () => {
  assert.equal(
    chatToolIterationLimit({
      CHAT_MAX_TOOL_ITERATIONS: 'nope'
    }),
    500
  )
  assert.equal(
    scheduledAgentToolCallLimit({
      SCHEDULED_AGENT_MAX_TOOL_CALLS: ''
    }),
    500
  )
  assert.equal(
    scheduledAgentToolIterationLimit({
      SCHEDULED_AGENT_MAX_TOOL_ITERATIONS: '-4'
    }),
    1
  )
  assert.equal(
    scheduledAgentTimeoutMs({
      SCHEDULED_AGENT_TIMEOUT_MS: '1'
    }),
    60_000
  )
})
