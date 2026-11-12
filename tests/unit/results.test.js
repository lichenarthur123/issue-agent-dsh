import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTaskResult, createRunState, reduceRunEvent } from '../../packages/desktop-agent/src/results.js'

const sessionId = 'session-test'

test('a fresh observation after a desktop action provides interface-level verification', () => {
  const state = createRunState()
  const events = [
    { type: 'tool/call', data: { callId: 'click-1', name: 'mcp__cua-driver-mcp__click' } },
    { type: 'tool/result', data: { message: { toolCallId: 'click-1', isError: false } } },
    { type: 'tool/call', data: { callId: 'read-1', name: 'mcp__cua-driver-mcp__get_window_state' } },
    { type: 'tool/result', data: { message: { toolCallId: 'read-1', isError: false } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '42' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  for (const event of events) reduceRunEvent(state, event)
  const result = buildTaskResult(state, sessionId, '/artifacts/session-test', '2026-01-01T00:00:00.000Z')
  assert.equal(result.status, 'unverified')
  assert.equal(result.answer, '42')
  assert.equal(result.verified, true)
  assert.equal(result.verification.level, 'interface')
  assert.equal(result.verification.business, false)
  assert.equal(result.desktopToolCalls, 2)
})

test('a new action invalidates the previous observation', () => {
  const state = createRunState()
  reduceRunEvent(state, { type: 'tool/call', data: { callId: 'click-1', name: 'mcp__cua-driver-mcp__click' } })
  reduceRunEvent(state, { type: 'tool/call', data: { callId: 'read-1', name: 'mcp__cua-driver-mcp__get_window_state' } })
  reduceRunEvent(state, { type: 'tool/result', data: { message: { toolCallId: 'read-1', isError: false } } })
  assert.equal(state.interfaceVerified, true)
  reduceRunEvent(state, { type: 'tool/call', data: { callId: 'click-2', name: 'mcp__cua-driver-mcp__click' } })
  assert.equal(state.interfaceVerified, false)
})

test('a timeout cancellation reports timeout', () => {
  const state = createRunState()
  reduceRunEvent(state, {
    type: 'turn/end',
    data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'timeout' } } },
  })
  const result = buildTaskResult(state, sessionId, '/artifacts/session-test', '2026-01-01T00:00:00.000Z')
  assert.equal(result.status, 'timeout')
  assert.equal(result.error.code, 'TIMEOUT')
  assert.equal(result.verified, false)
})

test('a blocked desktop call reports busy', () => {
  const state = createRunState()
  reduceRunEvent(state, { type: 'tool/call', data: { callId: 'click-1', name: 'mcp__cua-driver-mcp__click' } })
  reduceRunEvent(state, {
    type: 'tool/result',
    data: {
      message: {
        toolCallId: 'click-1',
        isError: true,
        content: [{ type: 'text', text: 'DESKTOP_BUSY: another agent is operating this desktop' }],
      },
    },
  })
  reduceRunEvent(state, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const result = buildTaskResult(state, sessionId, '/artifacts/session-test', '2026-01-01T00:00:00.000Z')
  assert.equal(result.status, 'busy')
  assert.equal(result.error.code, 'DESKTOP_BUSY')
})

test('a later successful call clears a previous busy mark', () => {
  const state = createRunState()
  reduceRunEvent(state, { type: 'tool/call', data: { callId: 'click-1', name: 'mcp__cua-driver-mcp__click' } })
  reduceRunEvent(state, {
    type: 'tool/result',
    data: { message: { toolCallId: 'click-1', isError: true, content: [{ type: 'text', text: 'DESKTOP_BUSY' }] } },
  })
  reduceRunEvent(state, { type: 'tool/call', data: { callId: 'click-2', name: 'mcp__cua-driver-mcp__click' } })
  reduceRunEvent(state, { type: 'tool/result', data: { message: { toolCallId: 'click-2', isError: false } } })
  reduceRunEvent(state, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const result = buildTaskResult(state, sessionId, '/artifacts/session-test', '2026-01-01T00:00:00.000Z')
  assert.equal(result.status, 'unverified')
  assert.equal(result.error, null)
})

test('an agent that stops before a turn ends reports cancelled', () => {
  const state = createRunState()
  const result = buildTaskResult(state, sessionId, '/artifacts/session-test', '2026-01-01T00:00:00.000Z')
  assert.equal(result.status, 'cancelled')
  assert.equal(result.error.code, 'CANCELLED')
})

test('a policy denial fails the task and is recorded', () => {
  const state = createRunState()
  reduceRunEvent(state, { type: 'tool/call', data: { callId: 'kill-1', name: 'mcp__cua-driver-mcp__kill_app' } })
  reduceRunEvent(state, {
    type: 'tool/result',
    data: {
      message: {
        toolCallId: 'kill-1',
        isError: true,
        content: [{ type: 'text', text: 'POLICY_DENIED: kill_app is blocked by the desktop policy' }],
      },
    },
  })
  reduceRunEvent(state, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const result = buildTaskResult(state, sessionId, '/artifacts/session-test', '2026-01-01T00:00:00.000Z')
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'POLICY_DENIED')
  assert.equal(result.policy.denials.length, 1)
  assert.equal(result.policy.denials[0].tool, 'kill_app')
})

test('business verification is required for succeeded', () => {
  const state = createRunState()
  state.businessVerified = true
  reduceRunEvent(state, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const result = buildTaskResult(state, sessionId, '/artifacts/session-test', '2026-01-01T00:00:00.000Z')
  assert.equal(result.status, 'succeeded')
  assert.equal(result.verification.business, true)
})
