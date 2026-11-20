import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'

const root = new URL('../..', import.meta.url).pathname
const stateDir = `${root}/artifacts/issue-agent-e2e`
const comments = []
let polls = 0
const issue = {
  number: 1,
  title: 'Non-GUI smoke test',
  body: '只回答数字 2，不要操作桌面。',
  user: { login: 'tester' },
  html_url: 'http://local.test/issues/1',
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/repos/acme/desktop/issues') {
    polls += 1
    return json(res, 200, [issue])
  }
  if (url.pathname === '/repos/acme/desktop/issues/1/comments' && req.method === 'GET') {
    return json(res, 200, comments)
  }
  if (url.pathname === '/repos/acme/desktop/issues/1/comments' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      comments.push(JSON.parse(body))
      json(res, 201, { html_url: 'http://local.test/comments/1' })
    })
    return
  }
  json(res, 404, { message: `${req.method} ${url.pathname}` })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

rmSync(stateDir, { recursive: true, force: true })
const child = spawn('dsh', ['--profile', 'issue-agent'], {
  cwd: root,
  env: {
    ...process.env,
    PATH: `${root}/.tools/node/bin:${root}/node_modules/.bin:${root}/.tools/bin:${process.env.PATH}`,
    DSH_HOME: `${root}/.tools/dsh-home`,
    GITHUB_REPOSITORY: 'acme/desktop',
    GITHUB_TOKEN: 'test-token',
    GITHUB_API_BASE: `http://127.0.0.1:${port}`,
    GITHUB_TRIGGER_LABEL: 'agent:desktop',
    GITHUB_POLL_INTERVAL_SECONDS: '5',
    AGENT_STATE_DIR: stateDir,
    AGENT_TASK_TIMEOUT_SECONDS: '120',
    DESKTOP_LOCAL_API_KEY: 'local',
    ...(process.env.E2E_USE_LOCAL === '1' ? {
      DESKTOP_PLANNER_PROVIDER: 'spark-planner-local',
      DESKTOP_EXECUTOR_PROVIDER: 'spark-executor-local',
    } : {
      DESKTOP_PLANNER_PROVIDER: 'alicloud',
      DESKTOP_PLANNER_MODEL: 'deepseek-v4.1-flash',
      DESKTOP_EXECUTOR_PROVIDER: 'alicloud',
      DESKTOP_EXECUTOR_MODEL: 'deepseek-v4.1-flash',
    }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', chunk => { output += chunk })
child.stderr.on('data', chunk => { output += chunk })

const deadline = Date.now() + 120000
try {
  while (comments.length === 0 && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh exited early:\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(comments.length, 1, output)
  assert.match(comments[0].body, /2/, output)
  assert.match(comments[0].body, /dsh-issue-agent:acme\/desktop#1/)
  assert.match(comments[0].body, /\*\*CUA plan\*\*/, output)
  await new Promise(resolve => setTimeout(resolve, 5500))
  assert.ok(polls >= 2)
  assert.equal(comments.length, 1, 'a later poll must not rerun or recomment the issue')
  if (process.env.E2E_VERBOSE === '1') console.error(output)
  console.log(`PASS: poll -> DSH Agent -> issue comment; ${polls} polls, one Agent run`)
} finally {
  child.kill('SIGTERM')
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 10000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  server.close()
  rmSync(stateDir, { recursive: true, force: true })
  if (comments.length === 0) console.error(output)
}
