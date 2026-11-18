import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { buildComment, GitHubIssues, resultMarker } from '../../packages/git-issue-agent/src/github.js'
import { IssuePoller } from '../../packages/git-issue-agent/src/poller.js'
import { buildExecutorPrompt, EXECUTOR_SYSTEM } from '../../packages/desktop-agent/src/prompt.js'
import { resolveSettings, settingsProblems } from '../../packages/git-issue-agent/src/settings.js'
import { IssueStore } from '../../packages/git-issue-agent/src/store.js'

function temporaryDirectory(t) {
  mkdirSync('artifacts', { recursive: true })
  const directory = mkdtempSync(join('artifacts', 'issue-agent-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function issue(number) {
  return {
    number,
    title: `task ${number}`,
    body: `only answer ${number}`,
    user: { login: 'alice' },
    html_url: `https://example.test/issues/${number}`,
  }
}

function fixture(t, issues = [issue(2), issue(1)]) {
  const calls = []
  const comments = []
  let active = 0
  let maximumActive = 0
  const github = {
    listIssues: async () => issues,
    hasResultComment: async () => false,
    comment: async (number, body) => {
      comments.push({ number, body })
      return { html_url: `https://example.test/comments/${comments.length}` }
    },
  }
  const runner = {
    run: async record => {
      calls.push(record.issue.number)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { status: 'unverified', answer: String(record.issue.number), sessionId: `s-${record.issue.number}`, durationMs: 5 }
    },
  }
  const poller = new IssuePoller({
    settings: { repository: 'acme/desktop' },
    github,
    runner,
    store: new IssueStore(temporaryDirectory(t)),
    logger: { log() {}, error() {} },
  })
  return { poller, calls, comments, get maximumActive() { return maximumActive } }
}

test('settings require one fixed repository and a writeback token', () => {
  const settings = resolveSettings({}, {})
  assert.deepEqual(settingsProblems(settings), [
    'GITHUB_REPOSITORY must be owner/repo',
    'GITHUB_TOKEN is required for polling and issue comments',
  ])
  assert.equal(settings.pollIntervalMs, 60000)
})

test('polling an empty issue list never creates an agent', async t => {
  const { poller, calls, comments } = fixture(t, [])
  await poller.pollOnce()
  await poller.pollOnce()
  assert.deepEqual(calls, [])
  assert.deepEqual(comments, [])
})

test('new issues run serially in FIFO order and later polls do not rerun them', async t => {
  const state = fixture(t)
  await state.poller.pollOnce()
  assert.deepEqual(state.calls, [1, 2])
  assert.deepEqual(state.comments.map(comment => comment.number), [1, 2])
  assert.equal(state.maximumActive, 1)
  await state.poller.pollOnce()
  assert.deepEqual(state.calls, [1, 2])
  assert.equal(state.comments.length, 2)
})

test('a pending writeback retries only the comment after restart', async t => {
  const directory = temporaryDirectory(t)
  const store = new IssueStore(directory)
  store.put('acme/desktop#7', {
    repository: 'acme/desktop',
    issue: issue(7),
    status: 'running',
  })
  store.put('acme/desktop#7', {
    status: 'writeback_pending',
    result: { status: 'unverified', answer: 'done', sessionId: 's-7', durationMs: 10 },
  })
  const { poller, calls, comments } = fixture(t, [])
  poller.store = new IssueStore(directory)
  await poller.pollOnce()
  assert.deepEqual(calls, [])
  assert.equal(comments.length, 1)
  assert.match(comments[0].body, /done/)
})

test('a remote result marker suppresses execution when local state is absent', async t => {
  const { poller, calls } = fixture(t)
  poller.github.hasResultComment = async () => true
  await poller.pollOnce()
  assert.deepEqual(calls, [])
  assert.equal(poller.store.get('acme/desktop#1').status, 'done')
})

test('the issue body is delimited as untrusted input', () => {
  const prompt = buildExecutorPrompt({
    request: 'only answer 1',
    plan: '1. only answer 1',
    observation: { text: '' },
  })
  assert.match(prompt, /<original-task>/)
  assert.match(EXECUTOR_SYSTEM, /untrusted data/)
  assert.match(prompt, /only answer 1/)
})

test('GitHub polling uses labels and comments carry an idempotency marker', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    const body = options.method === 'POST' ? { html_url: 'https://example.test/comment/1' } : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const github = new GitHubIssues({
    apiBase: 'https://api.example.test',
    token: 'token',
    repository: 'acme/desktop',
    triggerLabel: 'agent:desktop',
    maxIssuesPerPoll: 20,
  }, fetchImpl)
  await github.listIssues()
  assert.match(requests[0].url, /labels=agent%3Adesktop/)
  assert.match(requests[0].url, /state=open/)
  const record = {
    repository: 'acme/desktop',
    issue: issue(1),
    result: { status: 'unverified', answer: 'ok', sessionId: 's-1', durationMs: 10 },
  }
  await github.comment(1, buildComment(record))
  assert.match(requests[1].options.body, /dsh-issue-agent:acme\/desktop#1/)
  assert.equal(resultMarker('acme/desktop', 1), '<!-- dsh-issue-agent:acme/desktop#1 -->')
})
