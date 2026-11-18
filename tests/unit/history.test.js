import assert from 'node:assert/strict'
import test from 'node:test'
import { compactHistory, renderHistory, summarizeHistory } from '../../packages/desktop-agent/src/history.js'

function steps(count, action = index => `a${index + 1}`) {
  return Array.from({ length: count }, (_, index) => ({
    step: index + 1,
    action: { kind: 'action', action: action(index), target: 'x', value: '' },
    result: { status: 'succeeded', summary: 'ok' },
  }))
}

test('older steps are summarized instead of disappearing', () => {
  const history = steps(8)
  const recent = compactHistory(history)
  assert.deepEqual(recent.map(step => step.step), [4, 5, 6, 7, 8])
  const summary = summarizeHistory(history)
  assert.equal(summary.omittedCount, 3)
  assert.equal(summary.truncated, false)
  assert.match(summary.text, /#1 action a1 -> succeeded/)
  assert.match(summary.text, /#3 action a3 -> succeeded/)
  assert.equal(summarizeHistory(history.slice(0, 3)), null)
})

test('the history summary is bounded and reports what it drops', () => {
  const history = steps(60, index => `a${index + 1} ${'x'.repeat(100)}`)
  const summary = summarizeHistory(history, { maxChars: 500 })
  assert.equal(summary.truncated, true)
  assert.equal(summary.omittedCount, 55)
  assert.match(summary.text, /^\.\.\. \d+ earlier steps not shown/)
  assert.ok(summary.text.length <= 600)
  assert.match(summary.text, /#54 action a54/)
})

test('compact history clips long action fields', () => {
  const [step] = compactHistory([{
    step: 1,
    action: { kind: 'action', action: 'type', target: 't', value: 'x'.repeat(2000) },
    result: { status: 'failed', error: 'e'.repeat(2000) },
  }])
  assert.equal(step.action.value.length, 1000)
  assert.ok(step.action.value.endsWith('…'))
  assert.equal(step.result.error.length, 800)
  assert.ok(step.result.error.endsWith('…'))
})

test('history rendering degrades detail to fit its byte budget', () => {
  const history = steps(20, index => `a${index + 1} ${'汉'.repeat(100)}`)
  const text = renderHistory(history, { maxBytes: 1500 })
  assert.ok(Buffer.byteLength(text) <= 1500)
  assert.ok(text.includes('<history>'))
  assert.ok(!text.includes('<history-summary>'))
  const tiny = renderHistory(history, { maxBytes: 300 })
  assert.ok(Buffer.byteLength(tiny) <= 300)
})
