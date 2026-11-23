import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function writeJson(file, value) {
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export class CheckpointStore {
  constructor(root) {
    this.root = root
  }

  dir(runId) {
    return join(this.root, runId)
  }

  start(runId, record, goal) {
    const dir = this.dir(runId)
    mkdirSync(join(dir, 'steps'), { recursive: true, mode: 0o700 })
    const run = {
      runId,
      record,
      goal,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    writeJson(join(dir, 'run.json'), run)
    return run
  }

  append(runId, entry) {
    const dir = this.dir(runId)
    const step = readdirSync(join(dir, 'steps')).filter(file => file.endsWith('.json')).length + 1
    const checkpoint = {
      step,
      createdAt: new Date().toISOString(),
      ...entry,
    }
    writeJson(join(dir, 'steps', `${String(step).padStart(4, '0')}.json`), checkpoint)
    return checkpoint
  }

  list(runId) {
    const dir = join(this.dir(runId), 'steps')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .sort()
      .map(file => readJson(join(dir, file)))
      .filter(Boolean)
  }

  finish(runId, result) {
    const file = join(this.dir(runId), 'run.json')
    const run = readJson(file, { runId })
    writeJson(file, {
      ...run,
      status: result.status,
      answer: result.answer,
      error: result.error,
      steps: result.steps,
      totalActions: result.totalActions,
      durationMs: result.durationMs,
      finishedAt: new Date().toISOString(),
    })
  }

  load(runId) {
    return readJson(join(this.dir(runId), 'run.json'))
  }
}
