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

test('the latest twenty steps stay visible and older steps are summarized', () => {
  const history = steps(28)
  const recent = compactHistory(history)
  assert.equal(recent.length, 20)
  assert.equal(recent[0].step, 9)
  assert.equal(recent.at(-1).step, 28)
  const summary = summarizeHistory(history)
  assert.equal(summary.omittedCount, 8)
  assert.equal(summary.truncated, false)
  assert.match(summary.text, /#1 action a1 -> succeeded/)
  assert.match(summary.text, /#8 action a8 -> succeeded/)
  assert.equal(summarizeHistory(history.slice(0, 3)), null)
})

test('the history summary is bounded and reports what it drops', () => {
  const history = steps(60, index => `a${index + 1} ${'x'.repeat(100)}`)
  const summary = summarizeHistory(history, { maxChars: 500 })
  assert.equal(summary.truncated, true)
  assert.equal(summary.omittedCount, 40)
  assert.match(summary.text, /^\.\.\. \d+ earlier steps not shown/)
  assert.ok(summary.text.length <= 600)
  assert.match(summary.text, /#40 action a40/)
})

test('compact history clips long action fields', () => {
  const [step] = compactHistory([{
    step: 1,
    action: { kind: 'action', action: 'type', target: 't', value: 'x'.repeat(2000) },
    result: { status: 'failed', error: 'e'.repeat(2000) },
  }])
  assert.equal(step.action.value.length, 120)
  assert.ok(step.action.value.endsWith('…'))
  assert.equal(step.result.error.length, 200)
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

test('twenty realistic steps fit the default history budget', () => {
  const history = Array.from({ length: 25 }, (_, index) => ({
    step: index + 1,
    action: { kind: 'action', action: '点击商品卡片并打开详情页', target: 'SoundCore 无线降噪耳机', value: '', locate: 'ground' },
    result: { status: 'succeeded', summary: '页面已切换' },
  }))
  const text = renderHistory(history, { maxBytes: 4000 })
  assert.ok(Buffer.byteLength(text) <= 4000)
  assert.equal((text.match(/"step":/g) ?? []).length, 20)
  assert.match(text, /"step":6/)
  assert.match(text, /<history-summary>/)
  assert.match(text, /#1 action/)
})
