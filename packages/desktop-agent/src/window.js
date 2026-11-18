import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './log.js'
import { clip, PROMPT_LIMITS } from './prompt-budget.js'
import { CUA_TOOL_PREFIX, toolErrorText } from './results.js'

const runCommand = promisify(execFile)

async function invokeCuaTool(ctx, agent, name, args) {
  const batch = await ctx.tools.execute({
    calls: [{
      type: 'tool-call',
      id: `desktop-${randomUUID()}`,
      name: `${CUA_TOOL_PREFIX}${name}`,
      arguments: JSON.stringify(args),
    }],
    agent,
    signal: AbortSignal.timeout(30000),
  })
  const result = batch.results[0]?.result
  if (!result) throw new Error(`${name} returned no result`)
  const errorText = toolErrorText(result)
  if (errorText) throw new Error(errorText)
  return result.value
}

export async function callCuaTool(ctx, agent, name, args) {
  try {
    return await invokeCuaTool(ctx, agent, name, args)
  } catch (error) {
    const ended = /session '([^']+)' has ended/.exec(error.message ?? '')
    if (!ended || name === 'start_session') throw error
    log.exec(`session ${ended[1]} ended; reviving with start_session`)
    await invokeCuaTool(ctx, agent, 'start_session', { session: ended[1] })
    return invokeCuaTool(ctx, agent, name, args)
  }
}

export async function bringWindowToFront(ctx, agent, window, { attempts = 3 } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await callCuaTool(ctx, agent, 'bring_to_front', {
        pid: window.pid,
        window_id: window.window_id,
      })
      const payload = value?.structuredContent ?? value ?? {}
      const effect = payload.exact_window_effect
      const observed = payload.observed ?? {}
      // A same-app popup above the main window makes verified=false even though the
      // window is visible and focused; only a genuinely hidden window should fail.
      const visible = !effect || Object.keys(effect).length === 0
        ? payload.activated !== false
        : effect.verified === true
          || (effect.target_visible_ordinary === true
            && (observed.front_process_matches_target === true || effect.focused === true))
      if (!visible) {
        throw new Error(`window ${window.window_id} was not verified as visible on the current display`)
      }
      return payload
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  throw lastError ?? new Error('bring_to_front failed')
}

async function centerWindowOnScreen(ctx, agent, window) {
  const value = await callCuaTool(ctx, agent, 'get_screen_size', {})
  const screen = value?.structuredContent ?? value ?? {}
  const width = Number(screen.width)
  const height = Number(screen.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('the main display size is unavailable')
  }
  const sized = {
    width: Math.min(1280, Math.round(width * 0.8)),
    height: Math.min(860, Math.round(height * 0.8)),
  }
  const frame = {
    pid: window.pid,
    window_id: window.window_id,
    x: Math.max(0, Math.round((width - sized.width) / 2)),
    y: Math.max(24, Math.round((height - sized.height) / 2)),
    ...sized,
  }
  await callCuaTool(ctx, agent, 'set_window_frame', frame)
  log.exec(`window ${window.window_id} moved to ${frame.x},${frame.y} ${frame.width}x${frame.height} on the main display`)
}

async function reactivateApp(ctx, agent, window) {
  const value = await callCuaTool(ctx, agent, 'list_apps', {})
  const apps = (value?.structuredContent ?? value)?.apps ?? []
  const bundleId = apps.find(app => app?.pid === window.pid)?.bundle_id
  if (!bundleId) throw new Error(`no bundle id is known for pid ${window.pid}`)
  await runCommand('open', ['-b', bundleId])
  log.exec(`reactivated ${bundleId} to restore a minimized or hidden window`)
}

export async function ensureWindowVisible(ctx, agent, window, { reactivate = reactivateApp } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await bringWindowToFront(ctx, agent, window, { attempts: 1 })
    } catch (error) {
      lastError = error
      const repair = attempt === 0 ? reactivate : attempt === 1 ? centerWindowOnScreen : null
      if (repair) {
        try {
          await repair(ctx, agent, window)
        } catch (repairError) {
          log.exec(`window ${window.window_id} repair skipped: ${repairError.message}`)
        }
      }
    }
  }
  throw lastError ?? new Error('the target window could not be made visible')
}

const SKIP_ROLE = /^(AX)?(MenuBar|MenuBarItem|Group|ScrollBar|LayoutArea|LayoutItem|SplitGroup|Splitter|Toolbar|Ruler|GrowArea|BusyIndicator|ColorWell|LevelIndicator|Popover|Sheet|Drawer)$/i
const CONTROL_ROLE = /Button|Link|MenuItem|PopUp|ComboBox|CheckBox|RadioButton|Tab|TextField|TextArea|SearchField|Incrementor|Slider|Stepper|DisclosureTriangle/i
const SUPPORT_ROLE = /^(AX)?(Menu|ScrollArea)$/i
const ACTIONABLE_TEXT_ROLE = /StaticText|Image|Row|Cell/i
const CONTEXT_ROLE = /StaticText|Heading/i

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function visibleElement(element) {
  if (element.enabled === false || element.hidden === true || element.offscreen === true || element.visible === false) return false
  const frame = element.frame
  return !frame || (frame.w !== 0 && frame.h !== 0)
}

function hasPressAction(element) {
  return Array.isArray(element.actions) && element.actions.some(action => /press/i.test(action))
}

function formatElement(element) {
  const role = String(element.role ?? '').replace(/^AX/, '')
  const label = clip(normalizeText(element.label), 80)
  const value = clip(normalizeText(element.value), 120)
  const parts = [role]
  if (label) parts.push(`"${label}"`)
  if (value && value !== label) parts.push(`value="${value}"`)
  if (element.selected) parts.push('selected')
  if (element.focused === true || element.focus === true) parts.push('focused')
  return parts.join(' ')
}

function pushUnique(lines, keys, line, key) {
  if (keys.has(key)) return
  keys.add(key)
  lines.push(line)
}

function renderSection(title, lines, maxChars, unit) {
  if (lines.length === 0) return ''
  const included = []
  let size = title.length
  for (const line of lines) {
    if (size + 1 + line.length > maxChars) break
    included.push(line)
    size += 1 + line.length
  }
  let omitted = lines.length - included.length
  while (omitted > 0 && included.length > 0 && [title, ...included, `... omitted ${omitted} ${unit}`].join('\n').length > maxChars) {
    included.pop()
    omitted += 1
  }
  if (omitted > 0) included.push(`... omitted ${omitted} ${unit}`)
  return [title, ...included].join('\n')
}

export function renderElements(elements = [], { maxChars = PROMPT_LIMITS.ax, contextMaxChars = PROMPT_LIMITS.axContext } = {}) {
  const byIndex = new Map(elements.map(element => [element.element_index, element]))
  const inMenuBar = new Set()
  for (const element of elements) {
    let parent = byIndex.get(element.parent_index)
    for (let depth = 0; parent && depth < 12; depth += 1) {
      if (/^(AX)?MenuBar$/i.test(parent.role ?? '')) {
        inMenuBar.add(element.element_index)
        break
      }
      parent = byIndex.get(parent.parent_index)
    }
  }
  const controls = []
  const controlKeys = new Set()
  const context = []
  const contextKeys = new Set()
  let windowTitle = ''
  const focused = []
  for (const element of elements) {
    if (inMenuBar.has(element.element_index) || !visibleElement(element)) continue
    const role = element.role ?? ''
    if (SKIP_ROLE.test(role)) continue
    const label = normalizeText(element.label)
    const value = normalizeText(element.value)
    if (!label && !value) continue
    if (/^(AX)?Window$/i.test(role)) {
      windowTitle = clip(label || value, 200)
      continue
    }
    const formatted = formatElement(element)
    if (element.focused === true || element.focus === true) focused.push(formatted)
    const key = `${role}|${label}|${value}|${element.frame?.x ?? ''},${element.frame?.y ?? ''},${element.frame?.w ?? ''},${element.frame?.h ?? ''}`
    if (element.element_token && (CONTROL_ROLE.test(role) || SUPPORT_ROLE.test(role) || (ACTIONABLE_TEXT_ROLE.test(role) && hasPressAction(element)))) {
      pushUnique(controls, controlKeys, formatted, key)
    } else if (CONTEXT_ROLE.test(role)) {
      pushUnique(context, contextKeys, clip(label || value, 160), `${label}|${value}`)
    }
  }
  const contextLines = [
    ...windowTitle ? [`Window "${windowTitle}"`] : [],
    ...focused.map(line => `Focused: ${line}`),
    ...context,
  ]
  const contextText = renderSection('Context:', contextLines, contextMaxChars, 'context lines')
  const controlsText = renderSection('Controls:', controls, Math.max(0, maxChars - (contextText ? contextText.length + 2 : 0)), 'controls')
  return [controlsText, contextText].filter(Boolean).join('\n\n')
}

export async function captureWindow(ctx, agent, { pid, window_id, maxElements = 100, crop = null }) {
  const value = crop
    ? await callCuaTool(ctx, agent, 'zoom', { pid, window_id, ...crop })
    : await callCuaTool(ctx, agent, 'get_window_state', {
        pid,
        window_id,
        include_screenshot: true,
        include_accessibility_tree: true,
        max_elements: maxElements,
      })
  const structured = value.structuredContent ?? {}
  const image = value.content?.find(block => block.type === 'image' && (block.attachment || block.data))
  const base64 = image?.data ?? value.screenshot_png_b64 ?? structured.screenshot_png_b64
  if (!image?.attachment && !base64) throw new Error('window screenshot contained no image')
  const stored = image?.attachment
    ? await ctx.attachments.readImage(image.attachment)
    : {
        data: Buffer.from(base64, 'base64'),
        ref: {
          mediaType: image?.mimeType ?? value.screenshot_mime_type ?? value.mime_type ?? structured.screenshot_mime_type ?? structured.mime_type ?? 'image/png',
          width: structured.screenshot_width ?? structured.width ?? value.width ?? image?.width,
          height: structured.screenshot_height ?? structured.height ?? value.height ?? image?.height,
        },
      }
  const elements = crop ? [] : (structured.elements ?? [])
  const text = crop
    ? ''
    : elements.length
      ? renderElements(elements)
      : (value.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
  return {
    ...stored,
    text,
    pid,
    window_id,
    elements,
    maxElements,
    snapshotId: structured.snapshot_id,
  }
}
