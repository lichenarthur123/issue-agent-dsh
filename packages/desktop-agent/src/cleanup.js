import { randomUUID } from 'node:crypto'

const PREFIX = 'mcp__cua-driver-mcp__'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function messageText(message) {
  return (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

export class DesktopCleanup {
  constructor(ctx, agent) {
    this.ctx = ctx
    this.agent = agent
    this.running = false
    this.launchedPids = new Set()
    this.baseline = this.captureBaseline()
    this.restorePromise = null
  }

  async call(name, args) {
    this.running = true
    try {
      const batch = await this.ctx.tools.execute({
        calls: [{ type: 'tool-call', id: `cleanup-${randomUUID()}`, name: `${PREFIX}${name}`, arguments: JSON.stringify(args) }],
        agent: this.agent,
        signal: AbortSignal.timeout(20000),
      })
      const result = batch.results[0]?.result
      if (!result || result.isError) {
        throw new Error(result?.error?.message ?? `${name} returned no result`)
      }
      return result.value
    } finally {
      this.running = false
    }
  }

  async snapshot() {
    const value = await this.call('get_accessibility_tree', {})
    return value?.structuredContent ?? value
  }

  async captureBaseline() {
    try {
      return await this.snapshot()
    } catch {
      return null
    }
  }

  observe(event) {
    if (event.type === 'tool/call') {
      if (event.data.name === `${PREFIX}launch_app`) {
        this.launchCalls ??= new Map()
        this.launchCalls.set(event.data.callId, true)
      }
      return
    }
    if (event.type !== 'tool/result' || event.data.message.isError) return
    if (!this.launchCalls?.delete(event.data.message.toolCallId)) return
    const match = /\bpid\s+(\d+)/i.exec(messageText(event.data.message))
    if (match) this.launchedPids.add(Number(match[1]))
  }

  async restore() {
    if (this.restorePromise) return this.restorePromise
    this.restorePromise = this.restoreInternal()
    return this.restorePromise
  }

  async restoreInternal() {
    const baseline = await this.baseline
    if (!baseline) return { status: 'unavailable', reason: 'baseline snapshot failed' }
    const baselineWindows = new Set((baseline.windows ?? []).map(window => window.window_id))
    const baselinePids = new Set((baseline.apps ?? []).map(app => app.pid))
    const ownedPids = [...this.launchedPids].filter(pid => !baselinePids.has(pid))
    const report = {
      status: 'restored',
      closedWindowIds: [],
      quitAppPids: [],
      remainingWindowIds: [],
      remainingAppPids: [],
      errors: [],
    }
    try {
      const current = await this.snapshot()
      const newWindows = (current.windows ?? []).filter(window => !baselineWindows.has(window.window_id))
      for (const pid of ownedPids) {
        const window = (current.windows ?? []).find(item => item.pid === pid)
        try {
          await this.call('hotkey', {
            keys: ['cmd', 'q'],
            pid,
            ...(window ? { window_id: window.window_id, delivery_mode: 'foreground' } : {}),
          })
          report.quitAppPids.push(pid)
        } catch (error) {
          report.errors.push(`quit app ${pid}: ${error.message}`)
        }
      }
      for (const window of newWindows.filter(item => !ownedPids.includes(item.pid))) {
        try {
          await this.call('hotkey', {
            keys: ['cmd', 'w'],
            pid: window.pid,
            window_id: window.window_id,
            delivery_mode: 'foreground',
          })
          report.closedWindowIds.push(window.window_id)
        } catch (error) {
          report.errors.push(`close window ${window.window_id}: ${error.message}`)
        }
      }
      await delay(700)
      const final = await this.snapshot()
      report.remainingWindowIds = (final.windows ?? [])
        .filter(window => !baselineWindows.has(window.window_id))
        .map(window => window.window_id)
      report.remainingAppPids = (final.apps ?? [])
        .map(app => app.pid)
        .filter(pid => ownedPids.includes(pid))
      if (report.remainingWindowIds.length || report.remainingAppPids.length || report.errors.length) {
        report.status = 'partial'
      }
    } catch (error) {
      report.status = 'partial'
      report.errors.push(error.message)
    }
    return report
  }
}
