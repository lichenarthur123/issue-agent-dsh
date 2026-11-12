import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComment } from '../../packages/git-issue-agent/src/github.js'
import { CuaPlanner } from '../../packages/git-issue-agent/src/planner.js'
import { buildPrompt } from '../../packages/git-issue-agent/src/prompt.js'

const record = {
  repository: 'acme/desktop',
  issue: {
    number: 1,
    title: 'Calculate',
    body: 'Open Calculator and calculate 5 + 5',
    user: { login: 'alice' },
  },
}

function plannerWith(chunks, capture) {
  return new CuaPlanner({
    llm: {
      stream(options) {
        capture?.(options)
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }, { provider: 'alicloud', model: 'deepseek-v4.1-flash' })
}

test('the planner makes one text-only model call and assembles the plan', async () => {
  let request
  const planner = plannerWith([
    { type: 'text-delta', text: '目标\n计算 5+5\n\n步骤\n1. ' },
    { type: 'text-delta', text: '打开计算器' },
    { type: 'finish', reason: { kind: 'completed' } },
  ], value => { request = value })
  const plan = await planner.plan(record, AbortSignal.timeout(1000))
  assert.match(plan, /打开计算器/)
  assert.equal(request.tools, undefined)
  assert.equal(request.maxTokens, 2000)
  assert.match(request.messages[1].content[0].text, /5 \+ 5/)
})

test('planner failures stop before desktop execution', async () => {
  const planner = plannerWith([
    { type: 'finish', reason: { kind: 'error', failure: { message: 'provider rejected input' } } },
  ])
  await assert.rejects(planner.plan(record, AbortSignal.timeout(1000)), /provider rejected input/)
})

test('the execution prompt contains the generated plan and the original issue', () => {
  const prompt = buildPrompt(record, '', '目标\n计算\n\n步骤\n1. 打开计算器')
  assert.match(prompt, /<execution-plan>/)
  assert.match(prompt, /打开计算器/)
  assert.match(prompt, /Open Calculator/)
})

test('the issue comment includes the CUA plan', () => {
  const body = buildComment({
    repository: 'acme/desktop',
    issue: record.issue,
    result: {
      status: 'unverified',
      sessionId: 's-1',
      durationMs: 10,
      answer: '10',
      plan: '目标\n计算 5+5',
    },
  })
  assert.match(body, /\*\*CUA plan\*\*/)
  assert.match(body, /计算 5\+5/)
})
