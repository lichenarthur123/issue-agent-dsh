import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clickVariant,
  dragBetween,
  navigateSite,
  operateUi,
  pressChord,
  scrollWindow,
  selectOption,
  waitForScreen,
} from './actions.js'
import { PRESERVE_WINDOWS_ON_FAILURE } from './cleanup.js'
import { Executor } from './executor.js'
import { FeedbackLog } from './feedback.js'
import { log, logNode } from './log.js'
import { StepPlanner } from './planner.js'
import { CUA_TOOL_PREFIX } from './results.js'
import { VlVerifier } from './verifier.js'
import { callCuaTool, captureWindow, ensureWindowVisible } from './window.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function readResult(artifactRoot, sessionId) {
  try {
    return JSON.parse(readFileSync(join(artifactRoot, sessionId, 'result.json'), 'utf8'))
  } catch {
    return null
  }
}

function observationKey(observation) {
  // Screenshots almost always differ by a few pixels (cursor, animations), so the
  // structural AX text is the primary no-change signal; only image-only windows
  // fall back to the raw screenshot hash.
  if (observation?.text) return `ax:${observation.text}`
  return observation?.data
    ? `img:${createHash('sha256').update(Buffer.from(observation.data)).digest('hex').slice(0, 16)}`
    : 'empty'
}

function summarizeExecution(execution) {
  const failed = execution.calls.some(call => call.status === 'failed')
  const succeeded = execution.calls.length > 0 && execution.calls.every(call => call.status === 'succeeded')
  return {
    status: execution.status ?? (failed ? 'failed' : succeeded ? 'succeeded' : 'no-action'),
    calls: execution.calls.map(call => ({
      tool: call.tool,
      status: call.status,
      ...call.error ? { error: call.error } : {},
    })),
    ...execution.activation ? { activation: execution.activation } : {},
    ...execution.pageTarget ? { pageTarget: execution.pageTarget } : {},
    ...execution.response ? { response: execution.response.slice(0, 1000) } : {},
  }
}

export class DesktopTaskRunner {
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    this.settings.grounding ??= {}
    this.active = null
    this.operation = null
    this.targetWindow = null
    this.pageTarget = null
    this.knownWindows = new Map()
    this.driverPids = new Set()
    this.appsCache = null
  }

  stop() {
    this.operation?.abort()
    if (!this.active) return false
    try {
      this.active.agent.cancel({ kind: 'user' })
      return true
    } catch {
      return false
    }
  }

  isDriverWindow(window) {
    return window?.app_name === 'Cua Driver' || this.driverPids.has(window?.pid)
  }

  selectContentWindow(windows = []) {
    let selected = null
    let selectedScore = Number.NEGATIVE_INFINITY
    for (const window of windows) {
      if (this.isDriverWindow(window)) continue
      const width = window.bounds?.width ?? 0
      const height = window.bounds?.height ?? 0
      const score = (width >= 300 && height >= 200 ? 1000 : 0)
        + (window.is_on_screen === true ? 200 : 0)
        + (window.on_current_space === true ? 200 : 0)
        + (window.title?.trim() ? 50 : 0)
        + (typeof window.z_index === 'number' ? window.z_index / 1000 : 0)
      if (score > selectedScore) {
        selected = window
        selectedScore = score
      }
    }
    return selected
  }

  rememberWindows(windows = []) {
    for (const window of windows) {
      if (this.isDriverWindow(window)) continue
      if (!Number.isInteger(window.pid) || !Number.isInteger(window.window_id)) continue
      if (!this.knownWindows.has(window.pid)) this.knownWindows.set(window.pid, new Set())
      this.knownWindows.get(window.pid).add(window.window_id)
    }
  }

  validateExecutorCall(exec) {
    const pid = exec.arguments?.pid
    const windowId = exec.arguments?.window_id
    const tool = exec.name.slice(CUA_TOOL_PREFIX.length)
    if (this.pageTarget && ['browser_click', 'browser_pointer', 'browser_type'].includes(tool)) {
      return 'page refs can expire during model inference; use an element_token, or desktop_ground_ui followed by native click or type_text with x,y'
    }
    if (this.pageTarget && ['click', 'type_text'].includes(tool)
      && !exec.arguments?.element_token
      && (!Number.isInteger(exec.arguments?.x) || !Number.isInteger(exec.arguments?.y))) {
      return 'page interaction requires an element_token from the current snapshot, or desktop_ground_ui followed by native click or type_text with returned x,y'
    }
    if (pid === undefined && windowId === undefined) return undefined
    if (!Number.isInteger(pid)) return 'a real pid from Cua Driver is required; do not invent window identifiers'
    if (this.driverPids.has(pid)) return 'Cua Driver cannot target its own authorization process'
    if (['list_windows', 'list_apps'].includes(tool)) return undefined
    const windows = this.knownWindows.get(pid)
    if (!windows) return `unknown pid ${pid}; call list_windows and use a returned pid instead of guessing`
    if (windowId !== undefined && (!Number.isInteger(windowId) || !windows.has(windowId))) {
      return `unknown window_id ${windowId} for pid ${pid}; call list_windows and use a returned window_id`
    }
    return undefined
  }

  async observe(agent) {
    const observation = await this.observeWindow(agent)
    const apps = await this.describeInstalledApps(agent)
    return { ...observation, apps: apps.text, runningApps: apps.running }
  }

  async describeInstalledApps(agent) {
    if (this.appsCache && Date.now() - this.appsCache.at < 60_000) return this.appsCache.value
    let apps = []
    try {
      const value = await callCuaTool(this.ctx, agent, 'list_apps', {})
      const list = (value?.structuredContent ?? value)?.apps
      apps = Array.isArray(list) ? list : []
    } catch (error) {
      log.exec(`list_apps unavailable: ${error.message}`)
    }
    const installed = apps
      .filter(app => app?.bundle_id)
      .map(app => ({
        name: String(app.name ?? '').trim() || String(app.bundle_id),
        id: String(app.bundle_id),
        running: app.running === true,
      }))
    const value = {
      apps: installed,
      text: installed.map(app => `${app.name}(${app.id}${app.running ? ';running' : ''})`).join('; '),
      running: installed.filter(app => app.running).map(app => `${app.name}(${app.id})`).join('; '),
    }
    log.exec(`installed apps=${installed.length} running=${installed.filter(app => app.running).length}`)
    this.appsCache = { at: Date.now(), value }
    return value
  }

  resolveInstalledApp(installed, target) {
    const normalize = text => String(text ?? '').toLowerCase().replace(/\.app$/, '').replace(/\s+/g, ' ').trim()
    const wanted = normalize(target)
    if (!wanted) return { app: null, matches: [] }
    const exact = installed.find(app => normalize(app.id) === wanted)
      ?? installed.find(app => normalize(app.name) === wanted)
    if (exact) return { app: exact, matches: [exact] }
    const matches = installed.filter(app => {
      const name = normalize(app.name)
      const id = normalize(app.id)
      return name.includes(wanted) || id.includes(wanted) || (name.length >= 4 && wanted.includes(name))
    })
    return { app: matches.length === 1 ? matches[0] : null, matches }
  }

  async observeWindow(agent) {
    let snapshot
    try {
      const value = await callCuaTool(this.ctx, agent, 'get_accessibility_tree', {})
      snapshot = value.structuredContent ?? value
    } catch (error) {
      log.exec(`AX unavailable: ${error.message}`)
      return { text: `Desktop observation failed: ${error.message}` }
    }
    this.driverPids = new Set((snapshot.apps ?? [])
      .filter(app => app.bundle_id === 'com.trycua.driver')
      .map(app => app.pid))
    this.rememberWindows(snapshot.windows)
    const windows = (snapshot.windows ?? []).filter(window => !this.isDriverWindow(window))

    const capture = async window => {
      const observation = await captureWindow(this.ctx, agent, {
        pid: window.pid,
        window_id: window.window_id,
        maxElements: this.settings.maxElements ?? 300,
      })
      log.exec(`AX ok pid=${window.pid} window=${window.window_id} elements=${observation.elements.length} snapshot=${observation.snapshotId ?? 'none'}`)
      return observation
    }
    const attempt = async candidates => {
      let lastError = null
      for (const window of candidates) {
        try {
          return await capture(window)
        } catch (error) {
          lastError = error
        }
      }
      return { error: lastError ?? new Error('no candidate window') }
    }

    const target = this.isDriverWindow(this.targetWindow) ? null : this.targetWindow
    if (target) {
      const observation = await attempt([target])
      if (!observation.error) return observation
      log.exec(`target window ${target.window_id} is gone (${observation.error.message.slice(0, 120)}); reselecting`)
      this.targetWindow = null
      this.pageTarget = null
    }
    const selected = this.selectContentWindow(windows)
    if (!selected) {
      log.exec('AX unavailable: no visible application window')
      return { text: 'No visible application windows.' }
    }
    const observation = await attempt([
      selected,
      ...windows.filter(window => window.window_id !== selected.window_id || window.pid !== selected.pid),
    ])
    if (!observation.error) return observation
    log.exec(`window screenshot unavailable: ${observation.error.message}`)
    return { text: `Window screenshot unavailable: ${observation.error.message}` }
  }

  async activateLaunchedApp(agent, execution) {
    const launch = [...execution.calls].reverse().find(call => (
      call.tool === `${CUA_TOOL_PREFIX}launch_app` && call.status === 'succeeded'
    ))
    if (!launch) return
    const pid = Number.isInteger(launch.pid)
      ? launch.pid
      : Number(/\bpid\s+(\d+)/i.exec(launch.output ?? '')?.[1])
    if (!pid) {
      execution.activation = { status: 'failed', reason: 'launch result did not include a pid' }
      log.exec('launch activation failed: launch result did not include a pid')
      return
    }
    try {
      let window = null
      for (let attempt = 0; attempt < 5 && !window; attempt += 1) {
        const value = await callCuaTool(this.ctx, agent, 'list_windows', { pid, on_screen_only: false })
        const snapshot = value?.structuredContent ?? value
        const windows = snapshot?.windows ?? []
        this.rememberWindows(windows)
        window = this.selectContentWindow(windows)
        if (!window && attempt < 4) await delay(200)
      }
      if (!window) throw new Error(`no window is available for launched pid ${pid}`)
      this.targetWindow = { pid, window_id: window.window_id }
      await ensureWindowVisible(this.ctx, agent, this.targetWindow)
      execution.activation = { status: 'succeeded', ...this.targetWindow }
      log.exec(`activated pid=${pid} window=${window.window_id} on the current display`)
    } catch (error) {
      execution.activation = { status: 'failed', pid, reason: error.message }
      log.exec(`launch activation failed: ${error.message}`)
    }
  }

  async launchApp(agent, decision) {
    const execution = { calls: [], response: '' }
    const record = {
      callId: `desktop-${randomUUID()}`,
      tool: `${CUA_TOOL_PREFIX}launch_app`,
      status: 'pending',
    }
    execution.calls.push(record)
    let installed = []
    try {
      if (!decision.target) throw new Error('launch requires an application name or bundle id in target')
      installed = (await this.describeInstalledApps(agent)).apps
      const resolved = this.resolveInstalledApp(installed, decision.target)
      if (!resolved.app && resolved.matches.length > 1) {
        const offered = resolved.matches.slice(0, 10).map(app => `${app.name}(${app.id})`).join(' / ')
        throw new Error(`"${decision.target}" matches several installed apps: ${offered}`)
      }
      const bundleId = resolved.app?.id
      if (!bundleId) {
        const names = installed.map(app => app.name).join(' / ').slice(0, 800)
        throw new Error(`no installed app matches "${decision.target}"; installed apps: ${names || 'none'}`)
      }
      record.bundle_id = bundleId
      const value = await callCuaTool(this.ctx, agent, 'launch_app', { bundle_id: bundleId })
      const payload = value?.structuredContent ?? value ?? {}
      const pid = Number(payload.pid)
      if (!Number.isInteger(pid) || pid <= 0 || payload.launch_state?.process_running === false) {
        throw new Error(`launch_app did not start ${bundleId}: ${JSON.stringify(payload).slice(0, 300)}`)
      }
      record.pid = pid
      record.output = JSON.stringify(payload).slice(0, 500)
      record.status = 'succeeded'
      execution.response = `Launched ${resolved.app.name} (${bundleId})`
      log.exec(`launch resolved "${decision.target}" to ${bundleId}`)
      this.appsCache = null
    } catch (error) {
      record.status = 'failed'
      const names = installed.map(app => app.name).join(' / ').slice(0, 800)
      record.error = /no installed|not found/i.test(error.message) && names && !error.message.includes('installed apps:')
        ? `${error.message}; installed apps: ${names}`
        : error.message
      execution.response = record.error
      return execution
    }
    await this.activateLaunchedApp(agent, execution)
    return execution
  }

  async ensureFrontmost(agent, window) {
    if (!window?.pid) return true
    try {
      await ensureWindowVisible(this.ctx, agent, window)
      log.exec(`window visible pid=${window.pid} window=${window.window_id}`)
      return true
    } catch (error) {
      log.error(`window not visible pid=${window.pid} window=${window.window_id}: ${error.message}`)
      return false
    }
  }

  async withHeartbeat(agent, run) {
    const timer = setInterval(() => {
      callCuaTool(this.ctx, agent, 'get_session', { session: this.sessionId }).catch(() => {})
    }, 15000)
    try {
      return await run()
    } finally {
      clearInterval(timer)
    }
  }

  applyObservationMode(decision) {
    if (decision.kind === 'batch') {
      return { ...decision, actions: decision.actions.map(item => this.applyObservationMode(item)) }
    }
    if (this.settings.observationMode === 'screenshot'
      && ['action', 'double_click', 'right_click', 'drag'].includes(decision.kind)) {
      return { ...decision, locate: 'ground' }
    }
    return decision
  }

  async executeDecision(agent, decision, observation) {
    if (decision.kind === 'navigate' || decision.kind === 'launch') {
      this.settings.grounding.lastPoint = null
    }
    if (decision.kind === 'navigate') {
      const execution = await navigateSite(this.ctx, agent, {
        sessionId: this.sessionId,
        url: decision.url,
        selectWindow: windows => {
          this.rememberWindows(windows)
          return this.selectContentWindow(windows)
        },
        existing: this.pageTarget,
        profile: this.settings.browserProfile,
      })
      if (execution.pageTarget) {
        this.pageTarget = execution.pageTarget
        this.targetWindow = {
          pid: execution.pageTarget.pid,
          window_id: execution.pageTarget.windowId,
        }
        this.rememberWindows([{
          pid: execution.pageTarget.pid,
          window_id: execution.pageTarget.windowId,
        }])
      }
      return execution
    }
    if (decision.kind === 'launch') return this.launchApp(agent, decision)
    if (decision.kind === 'wait') return waitForScreen(decision)
    const window = this.targetWindow ?? (observation?.pid
      ? { pid: observation.pid, window_id: observation.window_id }
      : null)
    if (!window) {
      return {
        calls: [{
          tool: `${CUA_TOOL_PREFIX}click`,
          status: 'failed',
          error: 'no target window is available; open the required page or application first',
        }],
        response: 'no target window is available; open the required page or application first',
      }
    }
    const visible = await this.ensureFrontmost(agent, window)
    if (!visible) {
      return {
        calls: [{
          tool: `${CUA_TOOL_PREFIX}bring_to_front`,
          status: 'failed',
          error: `window ${window.window_id} could not be shown on the current display`,
        }],
        response: `window ${window.window_id} could not be brought to the front of the current display; it is probably minimized, hidden, or on another Space. Launch the application again or target a window that is visible.`,
      }
    }
    if (decision.kind === 'select') {
      return selectOption(this.ctx, agent, this.settings, decision, window, observation, this.operation.signal)
    }
    if (decision.kind === 'scroll') return scrollWindow(this.ctx, agent, decision, window, observation)
    if (decision.kind === 'key') return pressChord(this.ctx, agent, decision, window, observation)
    if (decision.kind === 'double_click') {
      return clickVariant(this.ctx, agent, this.settings, decision, window, observation, this.operation.signal, {
        tool: 'double_click',
        verb: 'Double-clicked',
      })
    }
    if (decision.kind === 'right_click') {
      return clickVariant(this.ctx, agent, this.settings, decision, window, observation, this.operation.signal, {
        tool: 'right_click',
        verb: 'Right-clicked',
      })
    }
    if (decision.kind === 'drag') {
      return dragBetween(this.ctx, agent, this.settings, decision, window, observation, this.operation.signal)
    }
    return operateUi(this.ctx, agent, this.settings, decision, window, observation, this.operation.signal)
  }

  async closePageSession(agent) {
    if (!this.pageTarget) return
    try {
      await callCuaTool(this.ctx, agent, 'end_session', { session: this.pageTarget.session })
      log.exec(`page session closed: ${this.pageTarget.session}`)
    } catch (error) {
      log.exec(`page session close failed: ${error.message}`)
    }
  }

  async run(record) {
    await this.ctx.get('loader')?.await()
    const startedAt = Date.now()
    let timedOut = false
    this.operation = new AbortController()
    const timer = setTimeout(() => {
      timedOut = true
      this.operation?.abort()
      try {
        this.active?.agent.cancel({ kind: 'hook', reason: 'timeout' })
      } catch {}
    }, this.settings.taskTimeoutMs)
    let handle

    try {
      const sessionId = `session-${randomUUID()}`
      this.sessionId = sessionId
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.settings.cwd },
        agentOptions: { ...this.settings.executor },
        setup: agentCtx => {
          agentCtx.tools.guard(exec => {
            if (!exec.name.startsWith(CUA_TOOL_PREFIX)) return undefined
            return this.validateExecutorCall(exec)
          })
        },
      })
      const agent = handle.agent
      this.active = { agent, key: record.key }
      await agent.whenIdle()
      try {
        await callCuaTool(this.ctx, agent, 'start_session', { session: sessionId })
        log.exec(`session started: ${sessionId}`)
      } catch (error) {
        log.exec(`start_session failed: ${error.message}`)
      }
      const planner = new StepPlanner(this.ctx, this.settings.planner)
      const executor = new Executor(this.ctx, this.settings.executor, {
        thinkingEffort: this.settings.thinkingEffort ?? 'medium',
        observationMode: this.settings.observationMode ?? 'hybrid',
        coordinateSpace: this.settings.executorCoordinateSpace ?? 'pixels',
        plannerEnabled: this.settings.plannerEnabled ?? false,
      })
      const verifier = new VlVerifier(this.ctx, this.settings.executor)
      const request = [record.issue.title, record.issue.body].filter(Boolean).join('\n\n').trim()
      const steps = []
      const history = []
      let observation = await this.observe(agent)
      const feedbacks = new FeedbackLog()
      let invalidDecisions = 0
      const thinkingMode = this.settings.thinkingMode ?? 'always'
      let thinking = thinkingMode === 'always'
      let lastSignature = ''
      let repeatCount = 0
      let finalResponse = ''
      let finalBlocked = false
      let unchangedCount = 0

      log.exec(`observation mode: ${this.settings.observationMode ?? 'hybrid'} | thinking mode: ${thinkingMode} | planner: ${this.settings.plannerEnabled ? 'enabled' : 'disabled'}`)
      const plan = this.settings.plannerEnabled
        ? await this.withHeartbeat(agent, () => planner.expand(record, observation, this.operation.signal))
        : null
      if (plan) logNode('plan', `plan: ${plan}`, Number.POSITIVE_INFINITY)
      else log.plan('planner disabled: using the original task directly')

      for (let index = 0; index < this.settings.maxSteps; index += 1) {
        if (this.operation.signal.aborted) throw new Error('task was cancelled')
        let decision
        try {
          decision = await this.withHeartbeat(agent, () => executor.decide({
            request,
            plan,
            history,
            observation,
            pageTarget: this.pageTarget,
            targetWindow: this.targetWindow ?? (observation.pid ? { pid: observation.pid, window_id: observation.window_id } : null),
            ...feedbacks.snapshot(),
            thinking,
            signal: this.operation.signal,
          }))
        } catch (error) {
          if (this.operation.signal.aborted) throw error
          invalidDecisions += 1
          log.error(`executor decision rejected: ${error.message}`)
          if (invalidDecisions >= 3) throw error
          feedbacks.set({
            status: 'rejected',
            reason: `invalid decision: ${error.message}. Return one valid action, or report a blocked task with done=true, blocked=true and a response.`,
          })
          if (!thinking && thinkingMode !== 'off') {
            thinking = true
            log.plan('thinking on: the last decision was unusable')
          }
          continue
        }
        invalidDecisions = 0
        feedbacks.consume()
        decision = this.applyObservationMode(decision)
        if (decision.done) {
          if (!decision.response) {
            log.plan('completion rejected: final response is empty')
            feedbacks.set({ status: 'rejected', reason: 'done requires a non-empty final response or a clear blocker' })
            if (!thinking && thinkingMode !== 'off') {
              thinking = true
              log.plan('thinking on: the final answer was empty')
            }
            continue
          }
          if (!decision.blocked && steps.length > 0) {
            const completion = observation.data
              ? await this.withHeartbeat(agent, () => verifier.verifyCompletion(record, observation, this.operation.signal))
              : { status: 'unverified', reason: 'no screenshot is available' }
            if (completion.status !== 'passed') {
              log.plan(`completion rejected: ${completion.reason}`)
              feedbacks.set({ status: completion.status, reason: completion.reason })
              if (!thinking && thinkingMode !== 'off') {
                thinking = true
                log.plan('thinking on: completion verification failed')
              }
              continue
            }
          }
          log.plan(`done: ${decision.response}`)
          finalResponse = decision.response
          finalBlocked = decision.blocked
          break
        }

        const beforeKey = observationKey(observation)
        const decisions = decision.kind === 'batch' ? decision.actions : [decision]
        if (decisions.length > 1) log.plan(`batch of ${decisions.length} actions in one round`)
        for (const current of decisions) {
          logNode('plan', [
            `step ${steps.length + 1}: ${current.kind} ${current.action}`,
            `locate=${current.locate}`,
            current.url && `url=${current.url}`,
            current.target && `target=${current.target}`,
            current.value && `value=${current.value}`,
          ].filter(Boolean).join(' | '), 400)
          const execution = await this.executeDecision(agent, current, observation)
          if (execution.fatal) throw new Error(execution.response || 'navigation failed')
          const step = { decision: current, execution: summarizeExecution(execution) }
          logNode('exec', [
            `step ${steps.length + 1} ${step.execution.status}`,
            step.execution.response ?? 'no response',
            `calls=${step.execution.calls.map(call => `${call.tool.replace(CUA_TOOL_PREFIX, '')}:${call.status}`).join(',')}`,
          ].join(' | '), 500)
          if (step.execution.status === 'failed') {
            feedbacks.set({
              status: 'failed',
              reason: `${step.execution.response ?? 'the action failed'}${decisions.length > 1 ? '; the rest of the batch was skipped' : ''}`,
            })
          }
          const signature = [current.kind, current.target, current.value, current.url].join('|')
          const repeated = signature === lastSignature
          lastSignature = signature
          repeatCount = repeated ? repeatCount + 1 : 0
          if (repeated && step.execution.status !== 'failed') {
            log.exec(`repeat target x${repeatCount + 1}: ${current.target || current.kind}`)
            if (!feedbacks.current) {
              feedbacks.set({
                status: 'no-progress',
                reason: `You have now issued the same action on "${current.target || current.kind}" ${repeatCount + 1} times and it is not working. Do not repeat it: try a different interaction such as kind=double_click or kind=right_click, use another control, or report done=true with blocked=true and an explanation.`,
              })
            }
          }
          if (current.kind !== 'wait') {
            if (step.execution.status !== 'succeeded' || repeated) {
              if (!thinking && thinkingMode !== 'off') {
                thinking = true
                log.plan(`thinking on: ${repeated ? 'the same action repeated' : 'the action made no progress'}`)
              }
            } else if (thinking && thinkingMode === 'adaptive') {
              thinking = false
              log.plan('thinking off: the step made progress')
            }
          }
          steps.push(step)
          history.push({
            step: steps.length,
            action: {
              kind: current.kind,
              action: current.action,
              url: current.url,
              target: current.target,
              value: current.value,
              locate: current.locate,
            },
            result: {
              status: step.execution.status,
              ...step.execution.response ? { summary: step.execution.response.slice(0, 300) } : {},
              ...step.execution.response && step.execution.status === 'failed'
                ? { error: step.execution.response }
                : {},
            },
          })
          if (step.execution.status === 'failed') break
        }
        if (steps.length > 0) {
          try {
            observation = await this.observe(agent)
          } catch (error) {
            log.exec(`observation after step ${steps.length} failed: ${error.message}`)
          }
        }
        const intentionalWait = decisions.every(current => current.kind === 'wait')
        const unchanged = !intentionalWait && observationKey(observation) === beforeKey
        if (unchanged) {
          unchangedCount += 1
          log.exec(`screen unchanged after step ${steps.length} (x${unchangedCount})`)
          const note = unchangedCount >= 2
            ? `The screen has not changed for ${unchangedCount} rounds in a row. Repeating the same target is useless; you must choose a different control or entry, or report done=true with blocked=true and an explanation.`
            : 'The screen did not change after this action. Do not repeat the same target; use a different control, wait for the page to load, or report blocked.'
          feedbacks.merge(note)
          if (!thinking && thinkingMode !== 'off') {
            thinking = true
            log.plan('thinking on: the screen did not change')
          }
        } else {
          unchangedCount = 0
        }
      }

      const failure = finalResponse ? null : {
        code: 'STEP_BUDGET_EXCEEDED',
        message: `executor exceeded ${this.settings.maxSteps} decisions`,
      }
      const succeeded = !failure && !finalBlocked && Boolean(finalResponse)
      logNode('plan', [
        `task ${failure ? 'failed' : succeeded ? 'succeeded' : 'unverified'}`,
        `steps=${steps.length}`,
        `duration=${Date.now() - startedAt}ms`,
        failure ? failure.code : finalBlocked ? 'blocked' : finalResponse,
      ].join(' | '), 400)
      if (succeeded && this.settings.browserProfile?.mode !== 'existing_profile') {
        await this.closePageSession(agent)
      }

      agent[PRESERVE_WINDOWS_ON_FAILURE] = Boolean(this.settings.keepWindowsOnFailure && !succeeded)
      await this.ctx.sessions.flush(agent.session)
      await handle.dispose()
      handle = null
      const result = readResult(this.settings.artifactRoot, sessionId)
      const status = failure ? 'failed' : succeeded ? 'succeeded' : 'unverified'
      return {
        sessionId,
        status,
        answer: finalResponse || result?.answer || '',
        plan: [
          plan ?? 'Planner disabled; executed directly from the original task.',
          steps.length
            ? `Executed:\n${steps.map((step, index) => `${index + 1}. ${step.decision.action}`).join('\n')}`
            : 'No desktop actions required.',
        ].join('\n\n'),
        steps,
        desktopToolCalls: result?.desktopToolCalls,
        groundingCalls: result?.groundingCalls,
        cleanup: result?.cleanup ?? null,
        error: failure ?? null,
        artifactDir: join(this.settings.artifactRoot, sessionId),
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      log.error(error?.message ?? String(error))
      return {
        sessionId: this.sessionId ?? undefined,
        status: timedOut ? 'timeout' : this.operation?.signal.aborted ? 'cancelled' : 'failed',
        answer: '',
        durationMs: Date.now() - startedAt,
        artifactDir: this.sessionId ? join(this.settings.artifactRoot, this.sessionId) : undefined,
        error: {
          code: timedOut ? 'TIMEOUT' : this.active ? 'AGENT_FAILED' : 'PLANNING_FAILED',
          message: error?.message ?? String(error),
        },
      }
    } finally {
      clearTimeout(timer)
      this.targetWindow = null
      this.pageTarget = null
      this.knownWindows.clear()
      this.driverPids.clear()
      this.operation = null
      this.sessionId = null
      this.active = null
      try {
        await handle?.dispose()
      } catch {}
    }
  }
}