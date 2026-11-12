import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CuaPlanner } from './planner.js'
import { buildPrompt } from './prompt.js'

function readResult(artifactRoot, sessionId) {
  try {
    return JSON.parse(readFileSync(join(artifactRoot, sessionId, 'result.json'), 'utf8'))
  } catch {
    return null
  }
}

export class AgentRunner {
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    this.active = null
    this.planning = null
  }

  selection() {
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    return selection === undefined ? undefined : { ...selection }
  }

  async drain(agent) {
    const subagents = this.ctx.get('subagents')
    while (true) {
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      if (!(await subagents?.waitForChildren?.(agent)) && agent.status === 'idle' && agent.session.seq === idleSeq) return
    }
  }

  stop() {
    if (this.planning) {
      this.planning.abort()
      return true
    }
    if (!this.active) return false
    try {
      this.active.agent.cancel({ kind: 'user' })
      return true
    } catch {
      return false
    }
  }

  async run(record) {
    await this.ctx.get('loader')?.await()
    const startedAt = Date.now()
    const sessionId = `session-${randomUUID()}`
    let handle
    let timedOut = false
    this.planning = new AbortController()
    const timer = setTimeout(() => {
      timedOut = true
      this.planning?.abort()
      try {
        handle?.agent.cancel({ kind: 'hook', reason: 'timeout' })
      } catch {}
    }, this.settings.taskTimeoutMs)

    try {
      const plan = await new CuaPlanner(this.ctx, this.selection()).plan(record, this.planning.signal)
      this.planning = null
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.settings.cwd },
        agentOptions: this.selection(),
      })
      const agent = handle.agent
      this.active = { agent, key: record.key }
      await agent.whenIdle()
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildPrompt(record, this.settings.promptSuffix, plan) }],
        source: { kind: 'user' },
      }))
      await this.drain(agent)
      await this.ctx.sessions.flush(agent.session)
      await handle.dispose()
      handle = null

      const result = readResult(this.settings.artifactRoot, sessionId)
      const base = {
        sessionId,
        plan,
        durationMs: Date.now() - startedAt,
        artifactDir: join(this.settings.artifactRoot, sessionId),
      }
      if (timedOut) {
        return { ...base, status: 'timeout', answer: result?.answer ?? '', error: { code: 'TIMEOUT', message: `task exceeded ${this.settings.taskTimeoutMs}ms` } }
      }
      if (!result) {
        return { ...base, status: 'failed', answer: '', error: { code: 'NO_RESULT', message: 'desktop-agent wrote no result.json' } }
      }
      return {
        ...base,
        status: result.status,
        answer: result.answer ?? '',
        desktopToolCalls: result.desktopToolCalls,
        cleanup: result.cleanup ?? null,
        error: result.error ?? null,
      }
    } catch (error) {
      return {
        sessionId,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        answer: '',
        error: {
          code: timedOut ? 'TIMEOUT' : handle ? 'AGENT_FAILED' : 'PLANNING_FAILED',
          message: error?.message ?? String(error),
        },
      }
    } finally {
      clearTimeout(timer)
      this.planning = null
      this.active = null
      try {
        await handle?.dispose()
      } catch {}
    }
  }
}
