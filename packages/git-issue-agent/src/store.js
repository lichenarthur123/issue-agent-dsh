import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class IssueStore {
  constructor(directory) {
    this.file = join(directory, 'issues.json')
    this.records = new Map()
    this.load()
  }

  load() {
    let data
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    for (const record of data.records ?? []) {
      if (record.status === 'running') record.status = 'queued'
      this.records.set(record.key, record)
    }
  }

  get(key) {
    return this.records.get(key)
  }

  put(key, patch) {
    const previous = this.records.get(key) ?? { key }
    const record = { ...previous, ...patch, updatedAt: new Date().toISOString() }
    this.records.set(key, record)
    this.save()
    return record
  }

  pending() {
    return [...this.records.values()]
      .filter(record => ['queued', 'writeback_pending'].includes(record.status))
      .sort((a, b) => a.issue.number - b.issue.number)
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    const records = [...this.records.values()]
    writeFileSync(temporary, JSON.stringify({ version: 1, records }, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}
