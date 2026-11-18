import assert from 'node:assert/strict'
import test from 'node:test'
import { FeedbackLog } from '../../packages/desktop-agent/src/feedback.js'
import { PROMPT_LIMITS } from '../../packages/desktop-agent/src/prompt-budget.js'

test('feedback is current for one decision and then remains as past feedback', () => {
  const log = new FeedbackLog()
  log.set({ status: 'failed', reason: 'first failure' })
  assert.deepEqual(log.snapshot(), {
    feedback: { status: 'failed', reason: 'first failure' },
    feedbackHistory: [],
  })
  log.consume()
  assert.deepEqual(log.snapshot(), {
    feedback: null,
    feedbackHistory: [{ status: 'failed', reason: 'first failure' }],
  })
  log.set({ status: 'rejected', reason: 'bad decision' })
  log.merge('screen unchanged')
  assert.equal(log.snapshot().feedback.reason, 'bad decision screen unchanged')
  assert.equal(log.snapshot().feedbackHistory.length, 1)
})

test('past feedback is capped and prompt reasons are clipped', () => {
  const log = new FeedbackLog({ maxPast: 2 })
  for (const reason of ['a', 'b', 'c']) {
    log.set({ status: 'failed', reason })
    log.consume()
  }
  assert.deepEqual(log.snapshot().feedbackHistory.map(item => item.reason), ['b', 'c'])
  log.set({ status: 'failed', reason: 'x'.repeat(2000) })
  assert.equal(log.snapshot().feedback.reason.length, PROMPT_LIMITS.feedbackCurrent)
  assert.ok(log.snapshot().feedback.reason.endsWith('…'))
})
