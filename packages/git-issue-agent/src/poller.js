import { buildComment } from './github.js'
import { issueKey } from './prompt.js'

export class IssuePoller {
  constructor({ settings, github, runner, store, logger = console }) {
    this.settings = settings
    this.github = github
    this.runner = runner
    this.store = store
    this.logger = logger
    this.stopped = false
    this.polling = null
    this.working = null
    this.timer = null
  }

  start() {
    this.poll()
    this.timer = setInterval(() => this.poll(), this.settings.pollIntervalMs)
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.runner.stop?.()
    await this.polling
    await this.working
  }

  poll() {
    if (this.stopped) return Promise.resolve()
    if (this.polling) return this.polling
    this.polling = this.pollOnce()
      .catch(error => this.logger.error(`git-issue-agent: poll failed: ${error.message}`))
      .finally(() => {
        this.polling = null
      })
    return this.polling
  }

  async pollOnce() {
    try {
      const issues = await this.github.listIssues()
      for (const issue of issues) {
        if (this.stopped) break
        const key = issueKey(this.settings.repository, issue.number)
        const existing = this.store.get(key)
        if (existing?.status === 'done') continue
        if (!existing || existing.status === 'writeback_pending') {
          if (await this.github.hasResultComment(issue.number)) {
            this.store.put(key, { repository: this.settings.repository, issue, status: 'done' })
            continue
          }
        }
        if (!existing) {
          this.store.put(key, {
            repository: this.settings.repository,
            issue,
            status: 'queued',
            createdAt: new Date().toISOString(),
          })
          this.logger.log(`git-issue-agent: queued ${key}`)
        }
      }
    } finally {
      await this.pump()
    }
  }

  pump() {
    if (this.working) return this.working
    this.working = this.pumpPending()
      .catch(error => this.logger.error(`git-issue-agent: task failed: ${error.message}`))
      .finally(() => {
        this.working = null
      })
    return this.working
  }

  async pumpPending() {
    while (!this.stopped) {
      const record = this.store.pending()[0]
      if (!record) return
      if (record.status === 'queued') {
        this.store.put(record.key, { status: 'running', startedAt: new Date().toISOString() })
        this.logger.log(`git-issue-agent: running ${record.key}`)
        const result = await this.runner.run(record)
        this.store.put(record.key, { status: 'writeback_pending', result })
      }
      const pending = this.store.get(record.key)
      const comment = await this.github.comment(pending.issue.number, buildComment(pending))
      this.store.put(record.key, { status: 'done', commentUrl: comment?.html_url ?? null })
      this.logger.log(`git-issue-agent: commented ${record.key} (${pending.result.status})`)
    }
  }
}
