import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './log.js'
import { CUA_TOOL_PREFIX } from './results.js'
import { callCuaTool, captureWindow, ensureWindowVisible } from './window.js'
import { groundUi } from './grounder.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const runCommand = promisify(execFile)

const normalizeLabel = text => String(text ?? '')
  .replace(/\s+/g, ' ')
  .replace(/[＊*]+\s*$/, '')
  .trim()

const VIEWPORT_TARGET = /^(page|screen|window|viewport|页面|屏幕|窗口|视口)$/i
const CLICKABLE_ROLE = /^(AX)?(Button|Link|MenuItem|Tab|CheckBox|RadioButton|DisclosureTriangle)$/i
const INPUT_ROLE = /^(AX)?(TextField|TextArea|SearchField|Incrementor|ComboBox)$/i
const POPUP_ROLE = /PopUpButton|ComboBox/i
const OPTION_ROLE = /^(AX)?(MenuItem|Option)$/i

function findActionableElement(elements, target, typing) {
  const wanted = normalizeLabel(target)
  if (!wanted) return null
  const role = typing ? INPUT_ROLE : CLICKABLE_ROLE
  const candidates = elements.filter(element => (
    role.test(element.role ?? '')
    && element.element_token
    && element.enabled !== false
  ))
  const exact = candidates.find(element => normalizeLabel(element.label ?? element.value) === wanted)
  if (exact) return exact
  const partial = candidates.filter(element => normalizeLabel(element.label ?? '').includes(wanted))
  return partial.length === 1 ? partial[0] : null
}

const PAGE_EDITABLE_ROLE = /^(textbox|searchbox|spinbutton)$/i

function findPageEditable(refs, target) {
  const editable = refs.filter(ref => PAGE_EDITABLE_ROLE.test(ref.role ?? '')
    || (ref.actions ?? []).includes('type'))
  if (editable.length === 0) return null
  const wanted = normalizeLabel(target)
  const exact = wanted ? editable.find(ref => normalizeLabel(ref.name) === wanted) : null
  if (exact) return exact
  const partial = wanted
    ? editable.filter(ref => {
        const name = normalizeLabel(ref.name)
        return Boolean(name) && (name.includes(wanted) || wanted.includes(name))
      })
    : []
  if (partial.length === 1) return partial[0]
  return editable.length === 1 ? editable[0] : null
}

function findPopup(elements, target) {
  const wanted = normalizeLabel(target)
  const candidates = elements.filter(element => (
    POPUP_ROLE.test(element.role ?? '')
    && element.in_web_content !== false
    && element.element_token
  ))
  return candidates.find(element => normalizeLabel(element.label) === wanted)
    ?? candidates.find(element => {
      const label = normalizeLabel(element.label)
      return Boolean(label) && (label.includes(wanted) || wanted.includes(label))
    })
    ?? null
}

function collectOptions(elements, popup) {
  const byIndex = new Map(elements.map(element => [element.element_index, element]))
  const options = []
  const push = element => {
    if (!options.some(item => normalizeLabel(item.label ?? item.value) === normalizeLabel(element.label ?? element.value))) {
      options.push(element)
    }
  }
  for (const element of elements) {
    if (!OPTION_ROLE.test(element.role ?? '') || !element.element_token) continue
    if (element.in_web_content !== true) continue
    let parent = byIndex.get(element.parent_index)
    for (let depth = 0; parent && depth < 8; depth += 1) {
      if (parent.element_token === popup.element_token) {
        push(element)
        break
      }
      parent = byIndex.get(parent.parent_index)
    }
  }
  if (options.length > 0) return options
  for (const element of elements) {
    if (!OPTION_ROLE.test(element.role ?? '') || !element.element_token) continue
    if (element.in_web_content !== true) continue
    let parent = byIndex.get(element.parent_index)
    for (let depth = 0; parent && depth < 8; depth += 1) {
      if (/^(AX)?Menu$/i.test(parent.role ?? '') && !/MenuBar/i.test(parent.role ?? '')) {
        push(element)
        break
      }
      parent = byIndex.get(parent.parent_index)
    }
  }
  return options
}

function matchOption(options, value) {
  const wanted = normalizeLabel(value)
  return options.find(element => normalizeLabel(element.label ?? element.value) === wanted)
    ?? options.find(element => {
      const label = normalizeLabel(element.label ?? element.value)
      return Boolean(label) && (label.includes(wanted) || wanted.includes(label))
    })
}

function hoverPoint(observation, element) {
  const frame = element?.frame
  if (!frame) return null
  const root = (observation?.elements ?? []).find(item => item.role === 'AXWindow' && item.frame?.w)
  const width = observation?.ref?.width
  if (!root || !width) return null
  const scale = width / root.frame.w
  return {
    x: Math.round((frame.x - root.frame.x + frame.w / 2) * scale),
    y: Math.round((frame.y - root.frame.y + frame.h / 2) * scale),
  }
}

async function hoverElement(ctx, agent, targetWindow, observation, element) {
  const point = hoverPoint(observation, element)
  if (!point) return
  try {
    await callCuaTool(ctx, agent, 'move_cursor', {
      target: { kind: 'window', pid: targetWindow.pid, window_id: targetWindow.window_id },
      x: point.x,
      y: point.y,
    })
    log.exec(`hover ${normalizeLabel(element.label ?? element.value)} at (${point.x},${point.y})`)
  } catch (error) {
    log.exec(`hover skipped: ${error.message}`)
  }
}

function sameValue(current, wanted) {
  if (current === wanted) return true
  const a = Number(current)
  const b = Number(wanted)
  return current !== '' && wanted !== '' && Number.isFinite(a) && Number.isFinite(b) && a === b
}

const MODIFIER_ALIASES = {
  command: 'cmd',
  cmd: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  control: 'ctrl',
  ctrl: 'ctrl',
  option: 'alt',
  alt: 'alt',
  shift: 'shift',
  fn: 'fn',
}
const MODIFIER_KEYS = new Set(['cmd', 'ctrl', 'alt', 'shift', 'fn'])
const KEY_ALIASES = { enter: 'return', esc: 'escape', backspace: 'delete', page_up: 'pageup', page_down: 'pagedown' }
const KEY_NAME = /^(return|tab|escape|space|delete|home|end|pageup|pagedown|up|down|left|right|f([1-9]|1[0-2])|[a-z0-9])$/

function findElementByLabel(elements, target) {
  const wanted = normalizeLabel(target)
  if (!wanted) return null
  const usable = (elements ?? []).filter(element => element?.element_token)
  const exact = usable.find(element => normalizeLabel(element.label ?? element.value) === wanted)
  if (exact) return exact
  const partial = usable.filter(element => normalizeLabel(element.label ?? '').includes(wanted))
  return partial.length === 1 ? partial[0] : null
}

function pixelPoint(decision, observation, settings) {
  if (!decision.point) return null
  if ((settings.executorCoordinateSpace ?? 'pixels') !== 'normalized_1000') return decision.point
  const width = observation?.ref?.width
  const height = observation?.ref?.height
  if (!width || !height) throw new Error('normalized point requires the screenshot dimensions')
  return {
    x: Math.round(decision.point.x * width / 1000),
    y: Math.round(decision.point.y * height / 1000),
  }
}

const OPTION_STEP = /option|dropdown|menu|选项|下拉|菜单/i

function optionAnchor(settings, decision) {
  if (!OPTION_STEP.test(decision.action ?? '')) return null
  return settings.grounding?.lastPoint ?? null
}

function createExecution() {
  const execution = { calls: [], response: '' }
  const invoke = async (ctx, agent, name, args) => {
    const entry = { callId: `act-${randomUUID()}`, tool: `${CUA_TOOL_PREFIX}${name}`, status: 'pending' }
    execution.calls.push(entry)
    entry.arguments = args
    try {
      await callCuaTool(ctx, agent, name, args)
      entry.status = 'succeeded'
    } catch (error) {
      entry.status = 'failed'
      entry.error = error.message
      throw error
    }
    return entry
  }
  return { execution, invoke }
}

export async function operateUi(ctx, agent, settings, decision, targetWindow, observation, signal, pageTarget = null) {
  const execution = { calls: [], response: '' }
  const record = name => {
    const entry = {
      callId: `act-${randomUUID()}`,
      tool: `${CUA_TOOL_PREFIX}${name}`,
      status: 'pending',
    }
    execution.calls.push(entry)
    return entry
  }
  const invoke = async (name, args) => {
    const entry = record(name)
    entry.arguments = args
    const value = await callCuaTool(ctx, agent, name, args)
    entry.status = 'succeeded'
    return value
  }
  const typing = Boolean(String(decision.value ?? '').trim())
  const groundingMode = settings.groundingMode ?? 'auto'
  try {
    if (typing && !decision.value) throw new Error('text input requires a non-empty value')
    const typed = String(decision.value ?? '')
    const submit = /\n\s*$/.test(typed)
    const value = submit ? typed.replace(/\s+$/, '') : typed.trim()
    if (typing && !value) throw new Error('text input requires text before the trailing newline')
    const pageBound = Boolean(pageTarget
      && pageTarget.pid === targetWindow.pid
      && pageTarget.windowId === targetWindow.window_id)
    const grounded = decision.locate === 'ground'
    const element = grounded ? null : findActionableElement(observation?.elements ?? [], decision.target, typing)
    const readPageValue = async refId => {
      if (!pageBound) return null
      try {
        const value = await callCuaTool(ctx, agent, 'get_browser_state', {
          session: pageTarget.session,
          target_id: pageTarget.targetId,
          tab_id: pageTarget.tabId,
          snapshot_format: 'semantic_v2',
        })
        const payload = value?.structuredContent ?? value
        return refId
          ? (payload?.refs ?? []).find(ref => ref.ref === refId) ?? null
          : findPageEditable(payload?.refs ?? [], decision.target)
      } catch (error) {
        log.exec(`typed value readback unavailable: ${error.message}`)
        return null
      }
    }
    const verifyTypedValue = async refId => {
      const current = await readPageValue(refId)
      if (!current || current.value === undefined || current.value === null) return null
      const expected = decision.expect?.value ?? value
      if (!sameValue(normalizeLabel(current.value), normalizeLabel(expected))) {
        throw new Error(`${decision.target} now reads ${current.value || '(empty)'} instead of ${expected}`)
      }
      return current
    }
    const pageEditable = typing && pageBound && settings.observationMode !== 'screenshot'
      && (!element || element.in_web_content === true)
    if (pageEditable) {
      let payload = null
      let snapshotError = null
      try {
        payload = await callCuaTool(ctx, agent, 'get_browser_state', {
          session: pageTarget.session,
          target_id: pageTarget.targetId,
          tab_id: pageTarget.tabId,
          snapshot_format: 'semantic_v2',
        })
        payload = payload?.structuredContent ?? payload
      } catch (error) {
        snapshotError = error
        log.exec(`page snapshot unavailable for typing: ${error.message}`)
      }
      const ref = findPageEditable(payload?.refs ?? [], decision.target)
      if (ref) {
        const pageArgs = {
          session: pageTarget.session,
          target_id: pageTarget.targetId,
          tab_id: pageTarget.tabId,
          ref: ref.ref,
        }
        if (sameValue(normalizeLabel(ref.value), normalizeLabel(value))) {
          if (submit) await invoke('browser_type', { ...pageArgs, text: '\n', mode: 'keystrokes' })
          execution.response = `${normalizeLabel(decision.target)} already shows ${value}; no typing needed${submit ? '; pressed return' : ''}`
          return execution
        }
        await invoke('browser_type', { ...pageArgs, text: value, replace: true })
        const current = await verifyTypedValue(ref.ref)
        if (submit) await invoke('browser_type', { ...pageArgs, text: '\n', mode: 'keystrokes' })
        execution.response = current
          ? `Replaced ${normalizeLabel(decision.target)} with ${value} via page ref ${ref.ref}; verified value${submit ? '; pressed return' : ''}`
          : `Typed ${value} into ${normalizeLabel(decision.target)} via page ref ${ref.ref}; value could not be read back${submit ? '; pressed return' : ''}`
        return execution
      }
      if (!grounded) {
        if (snapshotError) {
          throw new Error(`cannot read the bound page to verify "${decision.target}": ${snapshotError.message}; re-observe or navigate again`)
        }
        throw new Error(`no page textbox matches "${decision.target}" in the current browser snapshot; re-observe the page and use its visible label`)
      }
      log.exec(`no page textbox matches "${decision.target}"; falling back to grounded native typing`)
    }
    if (!grounded && !element) {
      throw new Error(`no accessibility element matches "${decision.target}"; use its exact AX label or set locate="ground"`)
    }
    const base = element
      ? {
          ...targetWindow,
          element_token: element.element_token,
          ...observation?.snapshotId ? { snapshot_id: observation.snapshotId } : {},
          delivery_mode: 'background',
        }
      : null

    if (!typing) {
      let args
      if (element) {
        args = base
        await hoverElement(ctx, agent, targetWindow, observation, element)
      } else if (decision.point && groundingMode === 'executor') {
        const pixel = pixelPoint(decision, observation, settings)
        args = { ...targetWindow, x: pixel.x, y: pixel.y, delivery_mode: 'foreground' }
      } else {
        if (groundingMode === 'executor') throw new Error('locate=ground requires the executor to provide point [x, y]')
        const point = await groundUi(ctx, agent, settings, {
          ...targetWindow,
          instruction: `click: ${decision.target}`,
          context: decision.action,
          anchor: decision.point ? null : optionAnchor(settings, decision),
          reference: groundingMode === 'grounder' ? null : pixelPoint(decision, observation, settings),
        }, signal)
        args = {
          ...targetWindow,
          x: point.x,
          y: point.y,
          delivery_mode: 'foreground',
          ...point.fromZoom ? { from_zoom: true } : {},
        }
      }
      await invoke('click', args)
      execution.response = element
        ? `Clicked ${normalizeLabel(element.label ?? element.value)} via AX ${element.element_token}`
        : `Clicked ${decision.target} at (${args.x},${args.y})`
      return execution
    }

    if (element && sameValue(normalizeLabel(element.value), normalizeLabel(value))) {
      if (submit) await invoke('press_key', { ...base, key: 'return' })
      execution.response = `${decision.target} already shows ${value}; no typing needed${submit ? '; pressed return' : ''}`
      return execution
    }
    let point = null
    if (element) {
      await hoverElement(ctx, agent, targetWindow, observation, element)
    } else if (decision.point && groundingMode === 'executor') {
      point = pixelPoint(decision, observation, settings)
      await invoke('click', { ...targetWindow, x: point.x, y: point.y, delivery_mode: 'foreground' })
    } else {
      if (groundingMode === 'executor') throw new Error('locate=ground requires the executor to provide point [x, y]')
      point = await groundUi(ctx, agent, settings, {
        ...targetWindow,
        instruction: `type into: ${decision.target}`,
        context: decision.action,
        reference: groundingMode === 'grounder' ? null : pixelPoint(decision, observation, settings),
      }, signal)
      await invoke('click', { ...targetWindow, x: point.x, y: point.y, delivery_mode: 'foreground' })
    }
    const target = base ?? { ...targetWindow, delivery_mode: 'foreground' }
    await invoke('hotkey', { ...target, keys: ['cmd', 'a'] })
    await invoke('press_key', { ...target, key: 'delete' })
    await invoke('type_text', point
      ? { ...targetWindow, x: point.x, y: point.y, delivery_mode: 'foreground', text: value }
      : { ...target, text: value })
    const current = pageBound ? await verifyTypedValue() : null
    if (submit) await invoke('press_key', { ...target, key: 'return' })
    execution.response = element
      ? `Replaced ${normalizeLabel(element.label ?? element.value)} with ${value} via AX ${element.element_token}${submit ? '; pressed return' : ''}`
      : current
        ? `Replaced ${decision.target} with ${value} at (${point.x},${point.y}); verified value${submit ? '; pressed return' : ''}`
        : `Typed ${value} into ${decision.target} at (${point.x},${point.y}); value could not be read back${submit ? '; pressed return' : ''}`
  } catch (error) {
    const pending = execution.calls.filter(entry => entry.status === 'pending')
    for (const entry of pending) {
      entry.status = 'failed'
      entry.error = error.message
    }
    if (pending.length === 0) {
      execution.calls.push({
        callId: `act-${randomUUID()}`,
        tool: typing ? `${CUA_TOOL_PREFIX}type_text` : `${CUA_TOOL_PREFIX}click`,
        status: 'failed',
        error: error.message,
      })
    }
    execution.response = error.message
  }
  return execution
}

export async function waitForScreen(decision) {
  const seconds = Math.min(Math.max(Number(decision.seconds ?? 2) || 2, 1), 10)
  await delay(seconds * 1000)
  return {
    calls: [],
    status: 'succeeded',
    response: `Waited ${seconds}s${decision.target ? ` for ${decision.target}` : ''}`,
  }
}

export async function scrollWindow(ctx, agent, decision, targetWindow, observation) {
  if (!targetWindow?.pid) throw new Error('scroll requires an active target window')
  const { execution, invoke } = createExecution()
  const element = decision.target && !VIEWPORT_TARGET.test(normalizeLabel(decision.target))
    ? findElementByLabel(observation?.elements ?? [], decision.target)
    : null
  const args = {
    ...targetWindow,
    ...element ? {
      element_token: element.element_token,
      ...observation?.snapshotId ? { snapshot_id: observation.snapshotId } : {},
    } : {},
    direction: decision.direction ?? 'down',
    amount: decision.amount ?? 3,
    by: decision.by ?? 'line',
    delivery_mode: 'foreground',
  }
  await invoke(ctx, agent, 'scroll', args)
  execution.response = element
    ? `Scrolled ${args.direction} ${args.amount} ${args.by} in ${normalizeLabel(element.label ?? element.value)}`
    : `Scrolled ${args.direction} ${args.amount} ${args.by}${decision.target
      ? ` (no AX match for ${decision.target}; used the focused region)`
      : ''}`
  return execution
}

export async function pressChord(ctx, agent, decision, targetWindow, observation) {
  if (!targetWindow?.pid) throw new Error('key requires an active target window')
  const { execution, invoke } = createExecution()
  const parts = String(decision.value ?? '').toLowerCase().split('+').map(part => part.trim()).filter(Boolean)
  const modifiers = []
  let key = ''
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part] ?? part
    if (MODIFIER_KEYS.has(alias)) modifiers.push(alias)
    else if (key) throw new Error('key accepts only one non-modifier key')
    else key = KEY_ALIASES[alias] ?? alias
  }
  if (!key) throw new Error('key requires a non-modifier key such as "return"')
  if (!KEY_NAME.test(key)) throw new Error(`unsupported key "${key}"`)
  const element = decision.locate === 'ground' ? null : findElementByLabel(observation?.elements ?? [], decision.target)
  const base = element
    ? {
        ...targetWindow,
        element_token: element.element_token,
        ...observation?.snapshotId ? { snapshot_id: observation.snapshotId } : {},
        delivery_mode: 'background',
      }
    : { ...targetWindow, delivery_mode: decision.locate === 'ground' ? 'foreground' : 'background' }
  const args = modifiers.length ? { ...base, keys: [...modifiers, key] } : { ...base, key }
  await invoke(ctx, agent, modifiers.length ? 'hotkey' : 'press_key', args)
  execution.response = `Pressed ${[...modifiers, key].join('+')}`
  return execution
}

export async function clickVariant(ctx, agent, settings, decision, targetWindow, observation, signal, { tool, verb }) {
  const { execution, invoke } = createExecution()
  try {
    if (!targetWindow?.pid) throw new Error(`${verb.toLowerCase()} requires an active target window`)
    const element = decision.locate === 'ground'
      ? null
      : findActionableElement(observation?.elements ?? [], decision.target, false)
    if (element) {
      await hoverElement(ctx, agent, targetWindow, observation, element)
      await invoke(ctx, agent, tool, {
        ...targetWindow,
        element_token: element.element_token,
        ...observation?.snapshotId ? { snapshot_id: observation.snapshotId } : {},
        delivery_mode: 'background',
      })
      execution.response = `${verb} ${normalizeLabel(element.label ?? element.value)} via AX ${element.element_token}`
      return execution
    }
    const groundingMode = settings.groundingMode ?? 'auto'
    const point = await groundUi(ctx, agent, settings, {
      ...targetWindow,
      instruction: `${verb.toLowerCase()}: ${decision.target}`,
      context: decision.action,
      anchor: decision.point ? null : optionAnchor(settings, decision),
      reference: groundingMode === 'grounder' ? null : pixelPoint(decision, observation, settings),
    }, signal)
    await invoke(ctx, agent, tool, {
      ...targetWindow,
      x: point.x,
      y: point.y,
      delivery_mode: 'foreground',
      ...point.fromZoom ? { from_zoom: true } : {},
    })
    execution.response = `${verb} ${decision.target} at (${point.x},${point.y})${point.fromZoom ? ' from_zoom' : ''}`
    return execution
  } catch (error) {
    for (const entry of execution.calls.filter(call => call.status === 'pending')) {
      entry.status = 'failed'
      entry.error = error.message
    }
    if (execution.calls.length === 0) {
      execution.calls.push({
        callId: `act-${randomUUID()}`,
        tool: `${CUA_TOOL_PREFIX}${tool}`,
        status: 'failed',
        error: error.message,
      })
    }
    execution.response = error.message
    return execution
  }
}

export async function dragBetween(ctx, agent, settings, decision, targetWindow, observation, signal) {
  const { execution, invoke } = createExecution()
  try {
    if (!targetWindow?.pid) throw new Error('drag requires an active target window')
    const resolve = async (label, instruction) => {
      if (decision.locate !== 'ground') {
        const element = findElementByLabel(observation?.elements ?? [], label)
        const point = element ? hoverPoint(observation, element) : null
        if (point) return point
      }
      return groundUi(ctx, agent, settings, { ...targetWindow, instruction: `${instruction}: ${label}` }, signal)
    }
    const from = await resolve(decision.target, 'drag from')
    const to = await resolve(decision.value, 'drag to')
    await invoke(ctx, agent, 'drag', {
      ...targetWindow,
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
      duration_ms: 500,
      delivery_mode: 'foreground',
    })
    execution.response = `Dragged ${decision.target} to ${decision.value}`
    return execution
  } catch (error) {
    for (const entry of execution.calls.filter(call => call.status === 'pending')) {
      entry.status = 'failed'
      entry.error = error.message
    }
    if (execution.calls.length === 0) {
      execution.calls.push({
        callId: `act-${randomUUID()}`,
        tool: `${CUA_TOOL_PREFIX}drag`,
        status: 'failed',
        error: error.message,
      })
    }
    execution.response = error.message
    return execution
  }
}

export async function selectOption(ctx, agent, settings, decision, targetWindow, observation, signal) {
  const execution = { calls: [], response: '' }
  const record = name => {
    const entry = {
      callId: `act-${randomUUID()}`,
      tool: `${CUA_TOOL_PREFIX}${name}`,
      status: 'pending',
    }
    execution.calls.push(entry)
    return entry
  }
  const clickElement = async (element, snapshotId) => {
    const entry = record('click')
    entry.arguments = {
      ...targetWindow,
      element_token: element.element_token,
      ...snapshotId ? { snapshot_id: snapshotId } : {},
      delivery_mode: 'background',
    }
    await callCuaTool(ctx, agent, 'click', entry.arguments)
    entry.status = 'succeeded'
  }
  const closeMenu = async () => {
    const entry = record('press_key')
    entry.arguments = { ...targetWindow, key: 'escape', delivery_mode: 'background' }
    try {
      await callCuaTool(ctx, agent, 'press_key', entry.arguments)
      entry.status = 'succeeded'
    } catch (error) {
      entry.status = 'failed'
      entry.error = error.message
    }
  }
  try {
    if (!targetWindow?.pid) throw new Error('select requires an active target window')
    if (!decision.target) throw new Error('select requires the field label in target')
    if (!decision.value) throw new Error('select requires the option text in value')
    let base = observation ?? {}
    let popup = findPopup(base.elements ?? [], decision.target)
    if (!popup) {
      base = await captureWindow(ctx, agent, { ...targetWindow, maxElements: 1000 })
      popup = findPopup(base.elements ?? [], decision.target)
    }
    const elements = base.elements ?? []
    if (!popup) {
      const labels = elements
        .filter(element => POPUP_ROLE.test(element.role ?? '') && element.in_web_content !== false)
        .map(element => normalizeLabel(element.label))
        .filter(Boolean)
      throw new Error(`no dropdown matches ${decision.target}; visible dropdowns: ${labels.join(' / ') || 'none'}`)
    }
    if (normalizeLabel(popup.value) === normalizeLabel(decision.value)) {
      execution.response = `${decision.target} already selects ${decision.value}; no change needed`
      return execution
    }

    await hoverElement(ctx, agent, targetWindow, base, popup)
    await clickElement(popup, base.snapshotId)
    await delay(350)
    const expanded = await captureWindow(ctx, agent, { ...targetWindow, maxElements: 1000 })
    const options = collectOptions(expanded.elements, popup)
    log.exec(`dropdown expanded: elements=${expanded.elements.length} options=${options.map(element => normalizeLabel(element.label ?? element.value)).filter(Boolean).join(' / ') || 'none'}`)
    const chosen = matchOption(options, decision.value)
    if (!chosen && options.length === 0) {
      log.exec(`dropdown menu is not in the AX tree; falling back to visual grounding for ${decision.value}`)
      const anchor = hoverPoint(base, popup)
      const point = await groundUi(ctx, agent, settings, {
        ...targetWindow,
        instruction: `click the "${decision.value}" option in the open dropdown menu of ${decision.target}`,
        context: decision.action,
        anchor: anchor ? { ...anchor, width: base.ref.width, height: base.ref.height } : null,
      }, signal)
      const visual = record('click')
      visual.arguments = {
        ...targetWindow,
        x: point.x,
        y: point.y,
        delivery_mode: 'background',
        ...point.fromZoom ? { from_zoom: true } : {},
      }
      await callCuaTool(ctx, agent, 'click', visual.arguments)
      visual.status = 'succeeded'
      await delay(200)
      const settled = await captureWindow(ctx, agent, { ...targetWindow, maxElements: 1000 })
      const current = findPopup(settled.elements, decision.target) ?? findPopup(settled.elements, popup.label)
      const actual = normalizeLabel(current?.value ?? current?.label)
      if (actual && actual === normalizeLabel(decision.value)) {
        execution.response = `Selected ${actual} in ${decision.target} via visual grounding`
        return execution
      }
      await closeMenu()
      throw new Error(`${decision.target} could not be set to ${decision.value}; it now reads ${actual || 'unknown'}`)
    }
    if (!chosen) {
      await closeMenu()
      const offered = options.map(element => normalizeLabel(element.label ?? element.value)).filter(Boolean)
      const current = normalizeLabel(popup.value) || 'the previous selection'
      throw new Error(`${decision.target} offers ${offered.slice(0, 12).join(' / ')} but not ${decision.value}; currently selected: ${current}. Retry select with one of the offered options, or with "${current}" to keep it.`)
    }

    await hoverElement(ctx, agent, targetWindow, expanded, chosen)
    await clickElement(chosen, expanded.snapshotId)
    await delay(200)
    await closeMenu()
    const after = await captureWindow(ctx, agent, { ...targetWindow, maxElements: 1000 })
    const current = findPopup(after.elements, decision.target) ?? findPopup(after.elements, popup.label)
    const actual = normalizeLabel(current?.value ?? current?.label)
    const expected = normalizeLabel(chosen.label ?? chosen.value)
    if (actual && actual !== expected) {
      throw new Error(`${decision.target} now reads ${actual} instead of ${expected}`)
    }
    execution.response = `Selected ${expected} in ${decision.target}`
  } catch (error) {
    const pending = execution.calls.filter(entry => entry.status === 'pending')
    for (const entry of pending) {
      entry.status = 'failed'
      entry.error = error.message
    }
    if (pending.length === 0) {
      execution.calls.push({
        callId: `act-${randomUUID()}`,
        tool: 'select',
        status: 'failed',
        error: error.message,
      })
    }
    execution.response = error.message
  }
  return execution
}

const EXISTING_BROWSER_NAME = /^(google chrome|chrome|microsoft edge|edge)$/i
const EXISTING_BROWSER_ID = /^(com\.google\.chrome|com\.microsoft\.edge)$/i
const CRASH_PAGE = /喔唷，崩溃啦|Aw, Snap|ERR_FILE_NOT_FOUND|ERR_CONNECTION_|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT/i

function isExistingBrowserWindow(window) {
  return EXISTING_BROWSER_NAME.test(String(window?.app_name ?? '').trim())
    || EXISTING_BROWSER_ID.test(String(window?.bundle_id ?? '').trim())
}

function isFatalNavigationError(error) {
  return /browser_consent_required|browser_wrong_target_refused|requires an open Google Chrome|browser crashed while loading/.test(error.message)
}

async function openExistingBrowser(profile, restart) {
  const app = profile.app ?? 'Google Chrome'
  const bundleId = app === 'Google Chrome' ? 'com.google.Chrome'
    : app === 'Microsoft Edge' ? 'com.microsoft.Edge'
      : null
  const language = String(profile.lang ?? 'en-US').split('-')[0]
  if (bundleId) {
    await runCommand('defaults', ['write', bundleId, 'AppleLanguages', '-array', language])
  }
  if (restart) {
    await runCommand('osascript', ['-e', `tell application "${app}" to quit`]).catch(() => {})
    await delay(2000)
  }
  await runCommand('open', ['-a', app, '--args', '--new-window'])
  await delay(1500)
}

export async function navigateSite(ctx, agent, { sessionId, url, selectWindow, existing = null, profile = { mode: 'isolated_new' }, openBrowser = openExistingBrowser, retryOnWrongTarget = true }) {
  const execution = { calls: [], response: '' }
  const call = async (name, args) => {
    const record = {
      callId: `act-${randomUUID()}`,
      tool: `${CUA_TOOL_PREFIX}${name}`,
      status: 'pending',
    }
    execution.calls.push(record)
    try {
      const value = await callCuaTool(ctx, agent, name, args)
      record.status = 'succeeded'
      record.output = JSON.stringify(value).slice(0, 500)
      return value
    } catch (error) {
      record.status = 'failed'
      record.error = error.message
      record.output = error.message
      throw error
    }
  }
  const settle = async (pid, windowId, navigateArgs) => {
    await delay(500)
    let text = ''
    try {
      text = (await captureWindow(ctx, agent, { pid, window_id: windowId, maxElements: 50 })).text
    } catch {
      return false
    }
    if (!CRASH_PAGE.test(text)) return false
    log.exec(`browser crash page detected; reloading ${navigateArgs.url} once`)
    await call('browser_navigate', navigateArgs)
    await delay(500)
    let retryText = ''
    try {
      retryText = (await captureWindow(ctx, agent, { pid, window_id: windowId, maxElements: 50 })).text
    } catch {
      return true
    }
    if (CRASH_PAGE.test(retryText)) throw new Error(`browser crashed while loading ${navigateArgs.url}`)
    return true
  }

  if (existing) {
    try {
      const navigateArgs = {
        session: existing.session,
        target_id: existing.targetId,
        tab_id: existing.tabId,
        url,
      }
      await call('browser_navigate', navigateArgs)
      const reloaded = await settle(existing.pid, existing.windowId, navigateArgs)
      execution.pageTarget = existing
      execution.response = `Navigated to ${url}${reloaded ? ' after one reload' : ''}`
      await ensureWindowVisible(ctx, agent, { pid: existing.pid, window_id: existing.windowId })
      execution.status = 'succeeded'
      log.exec(`page reused pid=${existing.pid} window=${existing.windowId} url=${url}`)
    } catch (error) {
      execution.fatal = isFatalNavigationError(error)
      execution.response = error.message
      log.exec(`navigation failed: ${error.message}`)
    }
    return execution
  }

  try {
    let pid
    let window
    if (profile.mode === 'existing_profile') {
      const findWindow = async () => {
        const listed = await call('list_windows', { on_screen_only: false })
        const snapshot = listed.structuredContent ?? listed
        const candidates = (snapshot.windows ?? []).filter(isExistingBrowserWindow)
        return { window: selectWindow(candidates), snapshot }
      }
      let found = await findWindow()
      if (!found.window) {
        await openBrowser(profile, false)
        found = await findWindow()
      }
      window = found.window
      if (!window) {
        const apps = [...new Set((found.snapshot.windows ?? []).map(item => item.app_name).filter(Boolean))].slice(0, 10).join(' / ')
        throw new Error(`existing_profile requires an open Google Chrome or Microsoft Edge window; open the browser and log in first${apps ? ` (open apps: ${apps})` : ''}`)
      }
      const prepare = async () => call('browser_prepare', {
        session: sessionId,
        pid: window.pid,
        window_id: window.window_id,
        strategy: { kind: 'existing_profile' },
      })
      let prepared
      try {
        prepared = await prepare()
      } catch (error) {
        if (!/browser_wrong_target_refused/.test(error.message)) throw error
        execution.calls.pop()
        await openBrowser(profile, true)
        found = await findWindow()
        window = found.window
        if (!window) throw new Error('existing_profile could not find the Chrome or Edge window after restarting the browser')
        prepared = await prepare()
      }
      pid = prepared.prepared_pid ?? prepared.structuredContent?.prepared_pid ?? window.pid
    } else {
      const launchProfile = profile.mode === 'isolated_named'
        ? { mode: 'isolated_named', name: profile.name ?? 'issue-agent' }
        : { mode: 'isolated_new' }
      const prepareArgs = {
        session: sessionId,
        allow_launch: true,
        profile: launchProfile,
      }
      let prepared
      try {
        prepared = await call('browser_prepare', prepareArgs)
      } catch (error) {
        if (!/browser_wrong_target_refused/.test(error.message)) throw error
        log.exec('isolated browser target mismatch; recreating the browser session once')
        try {
          await callCuaTool(ctx, agent, 'end_session', { session: sessionId })
        } catch (cleanupError) {
          log.exec(`stale browser session cleanup failed: ${cleanupError.message}`)
        }
        prepared = await call('browser_prepare', prepareArgs)
      }
      pid = prepared.prepared_pid ?? prepared.structuredContent?.prepared_pid
      if (!Number.isInteger(pid)) throw new Error('browser_prepare did not return prepared_pid')
      const listed = await call('list_windows', { pid, on_screen_only: false })
      const snapshot = listed.structuredContent ?? listed
      window = selectWindow(snapshot.windows ?? [])
      if (!window) throw new Error(`no content window is available for browser pid ${pid}`)
    }
    if (!Number.isInteger(pid)) throw new Error('browser_prepare did not return prepared_pid')
    const state = await call('get_browser_state', {
      session: sessionId,
      pid,
      window_id: window.window_id,
    })
    const page = state.structuredContent ?? state
    const targetId = page.target_id
    const tab = (page.tabs ?? []).find(item => item.active) ?? page.tabs?.[0]
    if (!targetId || !tab?.tab_id) throw new Error('get_browser_state did not return target_id and an active tab_id')
    const navigateArgs = {
      session: sessionId,
      target_id: targetId,
      tab_id: tab.tab_id,
      url,
    }
    await call('browser_navigate', navigateArgs)
    const reloaded = await settle(pid, window.window_id, navigateArgs)
    execution.pageTarget = {
      session: sessionId,
      targetId,
      tabId: tab.tab_id,
      pid,
      windowId: window.window_id,
    }
    execution.response = `Navigated to ${url}${reloaded ? ' after one reload' : ''}`
    try {
      await ensureWindowVisible(ctx, agent, { pid, window_id: window.window_id })
      execution.activation = { status: 'succeeded', pid, window_id: window.window_id }
    } catch (error) {
      execution.activation = { status: 'failed', pid, reason: error.message }
      log.exec(`activation failed: ${error.message}`)
    }
    execution.status = 'succeeded'
    log.exec(`navigated pid=${pid} window=${window.window_id} url=${url} profile=${profile.mode}`)
  } catch (error) {
    if (retryOnWrongTarget && profile.mode !== 'existing_profile' && /browser_wrong_target_refused/.test(error.message)) {
      log.exec('isolated browser binding failed; recreating the browser session once')
      try {
        await callCuaTool(ctx, agent, 'end_session', { session: sessionId })
      } catch (cleanupError) {
        log.exec(`stale browser session cleanup failed: ${cleanupError.message}`)
      }
      const previousCalls = execution.calls
      const retryProfile = profile.mode === 'isolated_named' ? { mode: 'isolated_new' } : profile
      log.exec(`retrying browser navigation with ${retryProfile.mode}`)
      const retried = await navigateSite(ctx, agent, {
        sessionId, url, selectWindow, existing, profile: retryProfile, openBrowser, retryOnWrongTarget: false,
      })
      retried.calls = [...previousCalls, ...retried.calls]
      return retried
    }
    const guidance = profile.mode === 'existing_profile'
      ? '; existing_profile requires Cua Driver started with --grant existing-profile and an open Chrome or Edge window'
      : ''
    execution.fatal = isFatalNavigationError(error)
    execution.response = `${error.message}${guidance}`
    log.exec(`navigation failed: ${execution.response}`)
  }
  return execution
}
