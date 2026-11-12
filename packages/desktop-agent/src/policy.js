import { CUA_TOOL_PREFIX } from './results.js'

const DEFAULT_BLOCKED_TOOLS = ['kill_app']
const DEFAULT_BLOCKED_SHORTCUTS = ['cmd+q', 'cmd+shift+q', 'cmd+opt+esc', 'ctrl+cmd+q']

const shortcutTools = new Set(['hotkey', 'press_key'])
const launchTools = new Set(['launch_app'])
const navigateTools = new Set(['browser_navigate'])

const modifierAliases = {
  command: 'cmd',
  cmd: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  option: 'opt',
  alt: 'opt',
  control: 'ctrl',
  ctrl: 'ctrl',
  shift: 'shift',
}

function collectStrings(value, depth = 0, out = []) {
  if (depth > 4 || value == null) return out
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, out)
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, depth + 1, out)
  }
  return out
}

export function normalizeShortcut(value) {
  const tokens = String(value)
    .toLowerCase()
    .split(/[+\s,]+/)
    .filter(Boolean)
    .map(token => modifierAliases[token] ?? token)
  return [...new Set(tokens)].sort().join('+')
}

function urls(values) {
  return values.filter(value => /^https?:\/\//i.test(value))
}

function hostAllowed(url, allowedHosts) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))
}

export function createPolicy(config = {}) {
  const blockedTools = new Set(
    (config.blockedTools ?? DEFAULT_BLOCKED_TOOLS).map(tool => String(tool).replace(CUA_TOOL_PREFIX, '')),
  )
  const blockedShortcuts = new Set(
    (config.blockedShortcuts ?? DEFAULT_BLOCKED_SHORTCUTS).map(normalizeShortcut),
  )
  const allowedApps = (config.allowedApps ?? []).map(app => String(app).toLowerCase())
  const allowedUrlHosts = (config.allowedUrlHosts ?? []).map(host => String(host).toLowerCase())

  return {
    rules: {
      blockedTools: [...blockedTools],
      blockedShortcuts: [...blockedShortcuts],
      allowedApps: [...allowedApps],
      allowedUrlHosts: [...allowedUrlHosts],
    },

    check(name, args) {
      if (typeof name !== 'string' || !name.startsWith(CUA_TOOL_PREFIX)) return undefined
      const tool = name.slice(CUA_TOOL_PREFIX.length)
      if (blockedTools.has(tool)) {
        return `POLICY_DENIED: ${tool} is blocked by the desktop policy`
      }

      const values = collectStrings(args)
      if (shortcutTools.has(tool) && blockedShortcuts.size > 0) {
        for (const candidate of [...values, values.join('+')]) {
          if (blockedShortcuts.has(normalizeShortcut(candidate))) {
            return `POLICY_DENIED: shortcut ${candidate} is blocked by the desktop policy`
          }
        }
      }

      if (launchTools.has(tool) && allowedApps.length > 0) {
        const allowed = values.some(value => {
          const lowered = value.toLowerCase()
          return allowedApps.some(app => lowered.includes(app))
        })
        if (!allowed) return `POLICY_DENIED: ${tool} target is not in allowedApps`
      }

      if (navigateTools.has(tool) && allowedUrlHosts.length > 0) {
        for (const url of urls(values)) {
          if (!hostAllowed(url, allowedUrlHosts)) {
            return `POLICY_DENIED: ${url} is not in allowedUrlHosts`
          }
        }
      }

      return undefined
    },
  }
}