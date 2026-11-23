import { randomUUID } from 'node:crypto'
import { CheckpointStore } from './checkpoint.js'
import { taskGoal, taskResult } from './results.js'
import { Supervisor } from './supervisor.js'

export class LongTaskRunner {
  constructor({ desktopTasks, llm, attachments, settings, supervisor = null, store = null }) {
    this.desktopTasks = desktopTasks
    this.settings = settings
    this.store = store ?? new CheckpointStore(settings.checkpointRoot)
    this.supervisor = supervisor ?? new Supervisor({
      llm,
      attachments,
      selection: settings.supervisor,
      thinkingEffort: settings.thinkingEffort,
    })
    this.active = new Map()
  }

  stop(runId) {
    const active = this.active.get(runId)
    if (!active) return false
    active.operation.abort()
    active.session?.stop?.()
    return true
  }

  stopAll() {
    for (const runId of this.active.keys()) this.stop(runId)
  }

  async run(record) {
    const goal = taskGoal(record)
    if (!goal) throw new Error('desktop-orchestrator: record.issue title or body is required')
    const runId = `run-${randomUUID()}`
    const startedAt = Date.now()
    const operation = new AbortController()
    let timedOut = false
    let session = null
    let totalActions = 0
    const timer = setTimeout(() => {
      timedOut = true
      operation.abort()
      session?.stop?.()
    }, this.settings.taskTimeoutMs)
    this.active.set(runId, { operation, session })
    this.store.start(runId, record, goal)

    const finish = (status, answer = '', error = null) => {
      const result = taskResult({
        runId,
        status,
        answer,
        error,
        checkpointDir: this.store.dir(runId),
        steps: this.store.list(runId).filter(entry => entry.type === 'step').length,
        totalActions,
        startedAt,
      })
      this.store.finish(runId, result)
      return result
    }

    try {
      if (typeof this.desktopTasks?.openSession !== 'function') {
        const error = new Error('desktop-agent must expose openSession(), session.step(), session.observe(), session.verify(), and session.close()')
        error.code = 'DESKTOP_SESSION_API_REQUIRED'
        throw error
      }
      session = await this.desktopTasks.openSession({
        sessionId: runId,
        cleanup: 'manual',
      })
      this.active.set(runId, { operation, session })
      let lastFeedback = ''

      while (this.store.list(runId).length < this.settings.maxSubtasks) {
        if (operation.signal.aborted) throw new Error('long task was cancelled')
        const observation = await session.observe()
        const checkpoints = this.store.list(runId)
        const directive = await this.supervisor.decide({
          goal,
          checkpoints,
          observation,
          lastFeedback,
          signal: operation.signal,
        })
        lastFeedback = ''

        if (directive.status === 'blocked') return finish('blocked', directive.reason)
        if (directive.status === 'done') {
          const verification = await session.verify({
            goal,
            observation,
            signal: operation.signal,
          })
          if (verification.status === 'passed') return finish('succeeded', directive.response)
          lastFeedback = verification.reason ?? 'whole-task verification did not pass'
          this.store.append(runId, {
            type: 'verification',
            directive,
            verification,
          })
          continue
        }

        const result = await session.step({
          instruction: directive.instruction,
          successEvidence: directive.successEvidence,
          maxActions: directive.maxActions,
          signal: operation.signal,
        })
        totalActions += Array.isArray(result.actions) ? result.actions.length : 0
        this.store.append(runId, { type: 'step', directive, result })
        if (result.status !== 'succeeded') {
          lastFeedback = result.error?.message ?? result.summary ?? `subgoal ended with ${result.status}`
        }
        if (totalActions > this.settings.maxTotalActions) {
          return finish('failed', '', {
            code: 'ACTION_BUDGET_EXCEEDED',
            message: `long task exceeded ${this.settings.maxTotalActions} desktop actions`,
          })
        }
      }
      return finish('failed', '', {
        code: 'SUBTASK_BUDGET_EXCEEDED',
        message: `long task exceeded ${this.settings.maxSubtasks} supervision rounds`,
      })
    } catch (error) {
      const status = timedOut ? 'timeout' : operation.signal.aborted ? 'cancelled' : 'failed'
      return finish(status, '', {
        code: timedOut ? 'TIMEOUT' : error.code ?? 'ORCHESTRATOR_FAILED',
        message: error?.message ?? String(error),
      })
    } finally {
      clearTimeout(timer)
      this.active.delete(runId)
      if (session) {
        try {
          await session.close({ cleanup: this.settings.cleanup })
        } catch (error) {
          console.error(`desktop-orchestrator: session close failed: ${error.message}`)
        }
      }
    }
  }
}
