import assert from 'node:assert/strict'
import test from 'node:test'
import { DesktopBudget } from '../../packages/desktop-agent/src/budget.js'
import { buildTaskResult, createRunState, reduceRunEvent } from '../../packages/desktop-agent/src/results.js'

const cua = name => `mcp__cua-driver-mcp__${name}`

test('oversized observations are rejected without consuming the call budget', () => {
  const budget = new DesktopBudget({ maxObservationElements: 150 })
  assert.match(
    budget.check(cua('get_window_state'), { max_elements: 600 }),
    /max_elements must be <= 150/,
  )
  assert.equal(budget.desktopCalls, 0)
  assert.equal(budget.exhausted, false)
  assert.equal(budget.check(cua('get_window_state'), { max_elements: 150 }), undefined)
  assert.equal(budget.desktopCalls, 1)
})

test('non-desktop tools do not consume the desktop budget', () => {
  const budget = new DesktopBudget({ maxDesktopCalls: 1 })
  assert.equal(budget.check('bash', {}), undefined)
  assert.equal(budget.desktopCalls, 0)
})

test('the desktop call limit is enforced', () => {
  const budget = new DesktopBudget({ maxDesktopCalls: 2 })
  budget.check(cua('click'))
  budget.check(cua('click'))
  assert.match(budget.check(cua('click')), /desktop call limit 2 reached/)
  assert.equal(budget.exhausted, true)
})

test('the observation limit is independent of mutations', () => {
  const budget = new DesktopBudget({ maxObservationCalls: 1, maxDesktopCalls: 5 })
  budget.check(cua('get_window_state'))
  budget.check(cua('click'))
  assert.match(budget.check(cua('get_window_state')), /observation limit 1 reached/)
  assert.equal(budget.desktopCalls, 3)
  assert.equal(budget.exhausted, true)
})

test('budget exhaustion produces an explicit partial failure', () => {
  const state = createRunState()
  state.contextBudgetExhausted = true
  state.answer = 'Partial answer'
  reduceRunEvent(state, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const result = buildTaskResult(state, 'session-budget', '/artifacts/session-budget', '2026-01-01T00:00:00.000Z')
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'CONTEXT_BUDGET_EXHAUSTED')
  assert.equal(result.answer, 'Partial answer')
})
