import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CheckpointStore } from '../../packages/desktop-orchestrator/src/checkpoint.js'
import { LongTaskRunner } from '../../packages/desktop-orchestrator/src/runner.js'
import { resolveSettings } from '../../packages/desktop-orchestrator/src/settings.js'
import { Supervisor } from '../../packages/desktop-orchestrator/src/supervisor.js'

const record = {
  key: 'local/repo#1',
  issue: { title: 'Complete a long task', body: 'Finish every milestone.' },
}

function createHarness(t, directives, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-orchestrator-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = { steps: [], observations: 0, close: null, verifications: 0 }
  const session = {
    async observe() {
      calls.observations += 1
      return { text: `observation ${calls.observations}` }
    },
    async step(directive) {
      calls.steps.push(directive)
      return options.step?.(directive) ?? {
        status: 'succeeded',
        summary: 'subgoal completed',
        actions: [{ kind: 'action', status: 'succeeded' }],
      }
    },
    async verify() {
      calls.verifications += 1
      return options.verify?.() ?? { status: 'passed', reason: 'complete' }
    },
    async close(closeOptions) {
      calls.close = closeOptions
    },
  }
  const supervisorCalls = []
  const supervisor = {
    async decide(input) {
      supervisorCalls.push(input)
      const directive = directives.shift()
      if (!directive) throw new Error('no scripted directive')
      return directive
    },
  }
  const settings = resolveSettings({
    checkpointRoot: root,
    taskTimeoutSeconds: 30,
    maxSubtasks: 10,
    maxTotalActions: 20,
    cleanup: 'preserve',
  })
  const store = new CheckpointStore(root)
  const runner = new LongTaskRunner({
    desktopTasks: { openSession: async () => session },
    settings,
    supervisor,
    store,
  })
  return { runner, store, calls, supervisorCalls }
}

test('orchestrator persists short-goal checkpoints and preserves the desktop', async t => {
  const harness = createHarness(t, [
    { status: 'continue', instruction: 'first subgoal', successEvidence: 'first evidence', maxActions: 3 },
    { status: 'continue', instruction: 'second subgoal', successEvidence: 'second evidence', maxActions: 4 },
    { status: 'done', response: 'all milestones completed' },
  ])
  const result = await harness.runner.run(record)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.answer, 'all milestones completed')
  assert.equal(result.steps, 2)
  assert.equal(result.totalActions, 2)
  assert.equal(harness.calls.steps.length, 2)
  assert.deepEqual(harness.calls.close, { cleanup: 'preserve' })
  assert.equal(harness.calls.verifications, 1)
  const checkpoints = harness.store.list(result.runId)
  assert.deepEqual(checkpoints.map(entry => entry.directive.instruction), ['first subgoal', 'second subgoal'])
  assert.equal(harness.store.load(result.runId).status, 'succeeded')
})

test('whole-task verification failure returns feedback to the supervisor', async t => {
  let attempts = 0
  const harness = createHarness(t, [
    { status: 'done', response: 'premature completion' },
    { status: 'done', response: 'verified completion' },
  ], {
    verify: () => ++attempts === 1
      ? { status: 'failed', reason: 'the final milestone is missing' }
      : { status: 'passed', reason: 'complete' },
  })
  const result = await harness.runner.run(record)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.answer, 'verified completion')
  assert.equal(harness.supervisorCalls[1].lastFeedback, 'the final milestone is missing')
  assert.equal(harness.store.list(result.runId)[0].type, 'verification')
})

test('a blocked supervisor decision closes the session without more steps', async t => {
  const harness = createHarness(t, [
    { status: 'blocked', reason: 'login is required' },
  ])
  const result = await harness.runner.run(record)
  assert.equal(result.status, 'blocked')
  assert.equal(result.answer, 'login is required')
  assert.equal(harness.calls.steps.length, 0)
  assert.deepEqual(harness.calls.close, { cleanup: 'preserve' })
})

test('a missing desktop session API produces an explicit capability error', async t => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-orchestrator-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runner = new LongTaskRunner({
    desktopTasks: {},
    settings: resolveSettings({ checkpointRoot: root, taskTimeoutSeconds: 30 }),
    supervisor: { decide: async () => assert.fail('supervisor must not be called') },
  })
  const result = await runner.run(record)
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'DESKTOP_SESSION_API_REQUIRED')
})

test('supervisor parses and bounds a short-goal decision', async () => {
  const supervisor = new Supervisor({
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: '{"status":"continue","instruction":"set quantity","successEvidence":"value is 3","maxActions":50}' }
      },
    },
    attachments: {},
    selection: { provider: 'test', model: 'test' },
  })
  const decision = await supervisor.decide({ goal: 'goal', checkpoints: [], observation: { text: 'screen' } })
  assert.deepEqual(decision, {
    status: 'continue',
    instruction: 'set quantity',
    successEvidence: 'value is 3',
    maxActions: 12,
  })
})
