import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DesktopBudget } from './budget.js'
import { DesktopCleanup, PRESERVE_WINDOWS_ON_FAILURE } from './cleanup.js'
import { registerGrounder } from './grounder.js'
import { DesktopMutex } from './mutex.js'
import { createPolicy } from './policy.js'
import { buildTaskResult, createRunState, CUA_TOOL_PREFIX, reduceRunEvent } from './results.js'
import { resolveDesktopSettings } from './settings.js'
import { DesktopTaskRunner } from './task-runner.js'

export const inject = ['agents', 'sessions', 'systemPrompt', 'tools', 'llm', 'attachments']

export function apply(ctx, config = {}) {
  const settings = resolveDesktopSettings(config)
  const artifactRoot = settings.artifactRoot
  const mutex = new DesktopMutex(config.lockFile ?? 'artifacts/desktop.lock')
  const policy = createPolicy(config.policy)
  const taskTimeoutMs = settings.taskTimeoutMs
  const budgetConfig = config.budget ?? {}
  const active = new Map()
  const taskRunner = new DesktopTaskRunner(ctx, settings)
  ctx.reflect.provide('desktopTasks', taskRunner)
  registerGrounder(ctx, settings)

  ctx.systemPrompt.section({
    name: 'desktop-cua-task',
    order: 900,
    interpolate: false,
    text: [
      'Operate the desktop only through the Cua Driver MCP tools.',
      'Do not use shell, file, or browser substitutes to bypass desktop observation or action.',
      'Prefer AX element_token addressing over pixel coordinates; use desktop_ground_ui only when AX cannot identify the target.',
      'Never invent pid, window_id, or element identifiers; only use values returned by Cua Driver.',
      'The task runner fronts the target window before input and verifies the final state before reporting success.',
      'A POLICY_DENIED or budget denial is final: do not retry it, report which action was blocked.',
      'The plugin cleans up windows and applications it opened after success; failed tasks may preserve them for debugging.',
    ].join('\n'),
  })

  const install = agent => {
    if (active.has(agent)) return
    const artifactDir = join(artifactRoot, agent.id)
    const eventLog = join(artifactDir, 'events.jsonl')
    const resultFile = join(artifactDir, 'result.json')
    const startedAt = new Date().toISOString()
    const state = createRunState()
    const budget = new DesktopBudget(budgetConfig)
    const cleanup = new DesktopCleanup(ctx, agent)
    let finalized = false
    const timer = taskTimeoutMs > 0
      ? setTimeout(() => {
        if (finalized) return
        state.timedOut = true
        try {
          agent.cancel({ kind: 'hook', reason: 'timeout' })
        } catch {}
      }, taskTimeoutMs)
      : undefined
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 })

    const writeResult = () => {
      if (timer) clearTimeout(timer)
      const result = buildTaskResult(state, agent.id, artifactDir, startedAt)
      writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
      finalized = true
      console.error(`desktop-cua: result: ${resultFile}`)
    }

    const disposeEvent = agent.ctx.on('session/event', (session, event) => {
      if (session.id !== agent.id) return
      cleanup.observe(event)
      reduceRunEvent(state, event)
      appendFileSync(eventLog, JSON.stringify(event) + '\n', { mode: 0o600 })
      if (event.type === 'turn/end') writeResult()
    })
    const disposeGuard = agent.ctx.tools.guard(exec => {
      if (!exec.name.startsWith(CUA_TOOL_PREFIX)) return undefined
      if (!cleanup.running) {
        const denial = policy.check(exec.name, exec.arguments)
        if (denial) return denial
        const budgetDenial = budget.check(exec.name, exec.arguments)
        if (budgetDenial) {
          if (budget.exhausted) state.contextBudgetExhausted = true
          return budgetDenial
        }
      }
      try {
        mutex.acquire(agent.id)
        return undefined
      } catch (error) {
        return error.message
      }
    })
    agent.ctx.effect(() => async () => {
      state.cleanup = agent[PRESERVE_WINDOWS_ON_FAILURE]
        ? { status: 'preserved', reason: 'task failed or incomplete' }
        : await cleanup.restore()
      writeResult()
    })

    active.set(agent, () => {
      if (timer) clearTimeout(timer)
      disposeEvent()
      disposeGuard()
      mutex.release(agent.id)
      if (!finalized) writeResult()
    })
  }

  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    active.get(agent)?.()
    active.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of active.values()) dispose()
    active.clear()
    mutex.releaseAll()
  })

  const signals = ['SIGINT', 'SIGTERM']
  const stopOnSignal = signal => {
    for (const dispose of active.values()) dispose()
    active.clear()
    mutex.releaseAll()
    for (const name of signals) process.removeListener(name, stopOnSignal)
    process.kill(process.pid, signal)
  }
  for (const name of signals) process.on(name, stopOnSignal)
  ctx.effect(() => () => {
    for (const name of signals) process.removeListener(name, stopOnSignal)
  })
}