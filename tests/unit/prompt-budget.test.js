import assert from 'node:assert/strict'
import test from 'node:test'
import { budgetBytes, budgetText, clip, textBytes, truncateBytes } from '../../packages/desktop-agent/src/prompt-budget.js'

test('clip keeps short values and ellipsizes long values', () => {
  assert.equal(clip('short', 10), 'short')
  assert.equal(clip(null, 10), '')
  assert.equal(clip('x'.repeat(20), 10), 'xxxxxxxxx…')
})

test('budgetText makes large-section truncation explicit', () => {
  const text = 'a'.repeat(50)
  assert.equal(budgetText(text, 60), text)
  assert.equal(
    budgetText(text, 20),
    `${'a'.repeat(20)}\n[truncated: showing first 20 of 50 characters]`,
  )
})

test('byte budgets preserve UTF-8 boundaries and include the marker', () => {
  const text = '汉'.repeat(100)
  const truncated = truncateBytes(text, 10)
  assert.equal(truncated, '汉'.repeat(3))
  assert.equal(textBytes(truncated), 9)
  const budgeted = budgetBytes(text, 50)
  assert.ok(textBytes(budgeted) <= 50)
  assert.match(budgeted, /truncated: 300 bytes total/)
})
