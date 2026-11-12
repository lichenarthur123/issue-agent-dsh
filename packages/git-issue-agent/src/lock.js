import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function acquireInstanceLock(directory) {
  const file = join(directory, 'instance.lock')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const record = { pid: process.pid, token: randomUUID() }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(record))
      } finally {
        closeSync(fd)
      }
      return () => {
        try {
          const current = JSON.parse(readFileSync(file, 'utf8'))
          if (current.token === record.token) unlinkSync(file)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let current
      try {
        current = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        current = null
      }
      if (current?.pid && alive(current.pid)) {
        throw new Error(`another git-issue-agent instance is running (pid ${current.pid})`)
      }
      unlinkSync(file)
    }
  }
  throw new Error('could not acquire the git-issue-agent instance lock')
}
