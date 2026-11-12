import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export class DesktopMutex {
  constructor(lockFile) {
    this.lockFile = resolve(lockFile)
    this.owners = new Map()
  }

  acquire(owner) {
    if (this.owners.has(owner)) return
    mkdirSync(dirname(this.lockFile), { recursive: true })
    const record = {
      token: randomUUID(),
      pid: process.pid,
      owner,
      acquiredAt: new Date().toISOString(),
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600)
        try {
          writeFileSync(fd, JSON.stringify(record), 'utf8')
        } finally {
          closeSync(fd)
        }
        this.owners.set(owner, record.token)
        return
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (!this.isStale()) {
          const busy = new Error('DESKTOP_BUSY: another agent is operating this desktop')
          busy.code = 'DESKTOP_BUSY'
          throw busy
        }
        unlinkSync(this.lockFile)
      }
    }
    throw new Error('DESKTOP_BUSY: desktop lock changed while it was being acquired')
  }

  release(owner) {
    const token = this.owners.get(owner)
    if (!token) return
    try {
      const record = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      if (record.token === token) unlinkSync(this.lockFile)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    } finally {
      this.owners.delete(owner)
    }
  }

  releaseAll() {
    for (const owner of [...this.owners.keys()]) this.release(owner)
  }

  isStale() {
    let record
    try {
      record = JSON.parse(readFileSync(this.lockFile, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return false
      return true
    }
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return true
    try {
      process.kill(record.pid, 0)
      return false
    } catch (error) {
      if (error.code === 'EPERM') return false
      if (error.code === 'ESRCH') return true
      throw error
    }
  }
}
