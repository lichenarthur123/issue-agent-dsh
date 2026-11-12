import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DesktopBudget } from './budget.js'
import { DesktopCleanup } from './cleanup.js'
import { DesktopMutex } from './mutex.js'
import { createPolicy } from './policy.js'
import { buildTaskResult, createRunState, CUA_TOOL_PREFIX, reduceRunEvent } from './results.js'

export const inject = ['agents', 'sessions', 'systemPrompt', 'tools']

export function apply(ctx, config = {}) {
  const artifactRoot = resolve(config.artifactRoot ?? 'artifacts/native')
  const mutex = new DesktopMutex(config.lockFile ?? 'artifacts/desktop.lock')
  const policy = createPolicy(config.policy)
  const taskTimeoutMs = config.taskTimeoutMs ?? 600000
  const budgetConfig = config.budget ?? {}
  const active = new Map()

  ctx.systemPrompt.section({
    name: 'desktop-cua-task',
    order: 900,
    interpolate: false,
    text: [
      'Operate the desktop only through the Cua Driver MCP tools.',
      'Do not use shell, file, or browser substitutes to bypass desktop observation or action.',
      'Minimize tool calls: prefer one batched input (type_text, hotkey, or a full shortcut) over per-key clicks, and do not re-observe while the current state is already known.',
      'For text or number entry, send the whole value in one type_text call, and use press_key or hotkey for actions instead of clicking individual keys.',
      'Take at most one snapshot to locate the target and one after the final change to verify; do not snapshot between individual actions.',
      `Keep every observation at max_elements <= ${budgetConfig.maxObservationElements ?? 150}; read the current viewport in small chunks instead of requesting a whole page.`,
      `The per-task budget is ${budgetConfig.maxDesktopCalls ?? 40} desktop calls and ${budgetConfig.maxObservationCalls ?? 12} observations; reserve one final observation for verification.`,
      'Bring the target window to the front before keyboard input when the app launched in the background.',
      'If an action produces no visible change, change approach (bring_to_front or foreground delivery) instead of repeating the same call; never repeat an identical failing call more than twice.',
      'After the final change, obtain one fresh window or desktop snapshot and verify the requested state before reporting success.',
      'Before the final response, close every browser tab you opened with cmd+w and restore any pre-existing tab you navigated away from; never close pre-existing tabs.',
      'The plugin closes newly opened windows and newly launched applications after the turn; leave unsaved changes prompts untouched.',
      'If the desktop is busy, a tool is unavailable, or verification fails, report the failure instead of claiming success.',
      'A POLICY_DENIED tool result is final: do not retry it, and report which action the policy blocked.',
      'On CONTEXT_BUDGET exhaustion, stop all tool calls and return a clearly marked partial result.',
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
      state.cleanup = await cleanup.restore()
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