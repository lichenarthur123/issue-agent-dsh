#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildComment } from '../../packages/git-issue-agent/src/github.js'
import { cases, smokeCase, smokeCaseIds } from './cases.mjs'
import { checkAnswer, checkState, extractState } from './lib/assert.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const siteUrl = 'http://127.0.0.1:8765/'
const patchFile = join(here, 'profile/desktop-task.yml')
const log = text => console.log(text)
const sleep = ms => new Promise(done => setTimeout(done, ms))
const tail = (text, lines = 30) => text.trim().split('\n').slice(-lines).join('\n')

function parseArgs(argv) {
  const options = {
    ids: [],
    suite: 'full',
    tag: null,
    smoke: false,
    allowUnverified: false,
    dryRun: false,
    list: false,
    timeout: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') options.list = true
    else if (arg === '--smoke') options.smoke = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--allow-unverified') options.allowUnverified = true
    else if (arg === '--suite') options.suite = argv[++index]
    else if (arg === '--tag') options.tag = argv[++index]
    else if (arg === '--timeout') options.timeout = Number(argv[++index])
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else options.ids.push(arg)
  }
  if (!['full', 'smoke'].includes(options.suite)) throw new Error('--suite must be full or smoke')
  if (options.timeout !== null && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
    throw new Error('--timeout must be a positive number of seconds')
  }
  return options
}

function selectCases(options) {
  if (options.smoke) return [smokeCase]
  let selected = cases.filter(item => (
    (options.suite === 'full' || smokeCaseIds.includes(item.id))
    && (!options.tag || item.tags.includes(options.tag))
  ))
  if (options.ids.length > 0) {
    const wanted = new Set(options.ids.map(value => String(value).toUpperCase()))
    selected = selected.filter(item => (
      wanted.has(item.id)
      || wanted.has(`TC${String(item.number).padStart(2, '0')}`)
      || wanted.has(String(item.number))
    ))
  }
  return selected
}

function printList(selected) {
  log('ID     timeout  tags')
  for (const item of selected) {
    log(`${item.id.padEnd(6)} ${String(item.timeoutSeconds ?? 600).padEnd(7)}  [${(item.tags ?? []).join(', ')}] ${item.title}`)
  }
}

async function siteUp() {
  try {
    const response = await fetch(siteUrl, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

async function ensureSite(runDir) {
  if (await siteUp()) return null
  const logFile = join(runDir, 'site.log')
  const descriptor = openSync(logFile, 'a')
  const child = spawn('bash', [join(root, 'tests/website/serve.sh')], {
    cwd: root,
    env: { ...process.env, PORT: '8765' },
    stdio: ['ignore', descriptor, descriptor],
  })
  closeSync(descriptor)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await siteUp()) return child
    await sleep(250)
  }
  child.kill('SIGTERM')
  throw new Error(`AmaShop did not start on ${siteUrl}; see ${logFile}`)
}

function driverReady() {
  const result = spawnSync('pgrep', ['-f', 'cua-driver serve.*--grant existing-profile'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  return result.status === 0 && Boolean(result.stdout.trim())
}

async function ensureDriver(runDir) {
  if (driverReady()) return false
  const status = spawnSync('cua-driver', ['status'], { encoding: 'utf8', timeout: 5000 })
  if (!status.error && status.status === 0) {
    throw new Error('Cua Driver is running without existing-profile authorization; restart it with: cua-driver stop && cua-driver serve --grant existing-profile')
  }
  const logFile = join(runDir, 'cua-driver.log')
  const descriptor = openSync(logFile, 'a')
  const child = spawn('cua-driver', ['serve', '--grant', 'existing-profile'], {
    cwd: root,
    stdio: ['ignore', descriptor, descriptor],
    detached: true,
  })
  child.unref()
  closeSync(descriptor)
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (driverReady()) return true
    await sleep(250)
  }
  throw new Error(`Cua Driver did not start with existing-profile authorization; see ${logFile}`)
}

function assertDesktopIdle() {
  const lockFile = join(root, 'artifacts/desktop.lock')
  if (!existsSync(lockFile)) return
  let record
  try {
    record = JSON.parse(readFileSync(lockFile, 'utf8'))
  } catch {
    return
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return
  let alive = true
  try {
    process.kill(record.pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') alive = false
    else if (error.code !== 'EPERM') alive = false
  }
  if (alive) {
    throw new Error(`desktop is busy (lock owner pid ${record.pid}); wait for that task or stop ./issue-agent.sh`)
  }
}

function warnRunningService() {
  const result = spawnSync('pgrep', ['-f', 'node .*dsh --profile issue-agent'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (result.status === 0 && result.stdout.trim()) {
    log('warning: another issue-agent service is running; stop it if it may compete for the desktop')
  }
}

function assertProfileReady() {
  const dshHome = process.env.DSH_HOME
  if (!dshHome) throw new Error('DSH_HOME is not set; run this suite through tests/desktop-task/run.sh')
  const pluginLink = join(dshHome, 'profiles/issue-agent/node_modules/@local/desktop-task-once')
  if (!existsSync(pluginLink)) {
    throw new Error('desktop-task-once is not linked into the issue-agent profile; run tests/desktop-task/run.sh')
  }
  if (!existsSync(patchFile)) throw new Error(`missing patch overlay ${patchFile}`)
}

async function runCase(item, runDir, options) {
  const caseDir = join(runDir, item.id)
  mkdirSync(caseDir, { recursive: true })
  const timeout = options.timeout ?? item.timeoutSeconds ?? 600
  const record = {
    key: `local-amashop#${item.id}`,
    repository: 'local/amashop',
    issue: {
      number: item.number,
      title: item.title,
      body: item.body,
      html_url: siteUrl,
      user: { login: 'local' },
    },
  }
  const recordFile = join(caseDir, 'record.json')
  const resultFile = join(caseDir, 'result.json')
  writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n')

  log(`[${item.id}] running: ${item.title}`)
  const startedAt = Date.now()
  const child = spawn('dsh', ['--profile', 'issue-agent', '--patch', patchFile], {
    cwd: root,
    env: {
      ...process.env,
      DESKTOP_TASK_FILE: recordFile,
      DESKTOP_TASK_OUT: resultFile,
      AGENT_TASK_TIMEOUT_SECONDS: String(timeout),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeChild = child
  const chunks = { stdout: [], stderr: [] }
  child.stdout.on('data', chunk => chunks.stdout.push(chunk))
  child.stderr.on('data', chunk => chunks.stderr.push(chunk))

  let timedOut = false
  const exit = await new Promise(done => {
    const hardTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 10000).unref()
    }, (timeout + 180) * 1000)
    child.on('error', error => {
      clearTimeout(hardTimer)
      done({ code: null, signal: null, error: error.message })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(hardTimer)
      done({ code, signal })
    })
  })
  activeChild = null
  const stdout = Buffer.concat(chunks.stdout).toString('utf8')
  const stderr = Buffer.concat(chunks.stderr).toString('utf8')
  writeFileSync(join(caseDir, 'stdout.log'), stdout)
  writeFileSync(join(caseDir, 'stderr.log'), stderr)

  let result
  try {
    result = JSON.parse(readFileSync(resultFile, 'utf8'))
  } catch {
    result = null
  }
  if (!result) {
    result = {
      status: timedOut ? 'timeout' : 'error',
      answer: '',
      durationMs: Date.now() - startedAt,
      error: {
        code: timedOut ? 'HARD_TIMEOUT' : 'NO_RESULT',
        message: tail(stderr) || tail(stdout) || 'dsh exited without writing a result',
      },
    }
  }

  const failures = []
  const statusAccepted = result.status === 'succeeded'
    || (options.allowUnverified && result.status === 'unverified')
  if (!statusAccepted) {
    const error = result.error ? ` (${result.error.code}: ${result.error.message})` : ''
    failures.push(`status=${result.status}${error}`)
  }
  const state = extractState(result.answer)
  const stateRules = item.assertions?.state ?? []
  if (stateRules.length > 0 && !state) failures.push('answer does not contain the state JSON block')
  if (state) failures.push(...checkState(state, stateRules))
  failures.push(...checkAnswer(result.answer, item.assertions?.answer ?? []))

  const comment = buildComment({ ...record, result })
  writeFileSync(join(caseDir, 'comment.md'), comment)
  const verdict = {
    id: item.id,
    title: item.title,
    ok: failures.length === 0,
    status: result.status,
    failures,
    durationMs: result.durationMs ?? Date.now() - startedAt,
    sessionId: result.sessionId ?? null,
    artifactDir: result.artifactDir ?? null,
    exit,
    timedOut,
    caseDir,
  }
  writeFileSync(join(caseDir, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n')

  if (verdict.ok) {
    log(`[PASS] ${item.id} ${(verdict.durationMs / 1000).toFixed(1)}s`)
  } else {
    log(`[FAIL] ${item.id} ${(verdict.durationMs / 1000).toFixed(1)}s`)
    for (const failure of failures) log(`       - ${failure}`)
    log(`       logs: ${caseDir}`)
  }
  return verdict
}

let activeChild = null
let siteChild = null

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.list) {
    printList([smokeCase, ...cases])
    return
  }
  const selected = selectCases(options)
  if (selected.length === 0) throw new Error('no cases selected')
  if (options.dryRun) {
    printList(selected)
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = join(here, 'results', stamp)
  mkdirSync(runDir, { recursive: true })
  log(`results: ${runDir}`)

  assertProfileReady()
  warnRunningService()
  siteChild = await ensureSite(runDir)
  await ensureDriver(runDir)
  assertDesktopIdle()
  if (siteChild) log('AmaShop started on 127.0.0.1:8765')

  const verdicts = []
  for (const item of selected) {
    verdicts.push(await runCase(item, runDir, options))
  }

  const failed = verdicts.filter(item => !item.ok)
  const summary = {
    startedAt: stamp,
    total: verdicts.length,
    passed: verdicts.length - failed.length,
    failed: failed.length,
    cases: verdicts,
  }
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  if (siteChild) {
    siteChild.kill('SIGTERM')
    siteChild = null
  }
  log('')
  log(`summary: ${summary.passed}/${summary.total} passed`)
  for (const item of verdicts) {
    log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.id}  ${countFailures(item)}`)
  }
  log(`results: ${runDir}`)
  process.exitCode = failed.length > 0 ? 1 : 0
}

function countFailures(item) {
  return item.failures.length > 0 ? `(${item.failures.length} issue${item.failures.length === 1 ? '' : 's'})` : ''
}

process.on('SIGINT', () => {
  console.error('\ninterrupted: stopping the current task')
  activeChild?.kill('SIGTERM')
  siteChild?.kill('SIGTERM')
  setTimeout(() => process.exit(130), 3000).unref()
})

main().catch(error => {
  console.error(`error: ${error.message}`)
  siteChild?.kill('SIGTERM')
  process.exitCode = 1
})