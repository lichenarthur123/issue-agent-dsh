export const CUA_TOOL_PREFIX = 'mcp__cua-driver-mcp__'

export const OBSERVATION_TOOLS = new Set([
  'get_window_state',
  'get_desktop_state',
  'get_accessibility_tree',
  'get_browser_state',
  'verify_state',
  'zoom',
])

const mutationTools = new Set([
  'bring_to_front',
  'browser_click',
  'browser_dialog',
  'browser_download',
  'browser_navigate',
  'browser_pointer',
  'browser_set_input_files',
  'browser_type',
  'click',
  'clipboard_write',
  'double_click',
  'drag',
  'hotkey',
  'invoke_menu',
  'kill_app',
  'launch_app',
  'move_cursor',
  'press_key',
  'right_click',
  'scroll',
  'set_value',
  'set_window_frame',
  'type_text',
])

export function createRunState() {
  return {
    answer: '',
    agentReason: null,
    toolCalls: 0,
    desktopToolCalls: 0,
    desktopMutationSeen: false,
    interfaceVerified: false,
    timedOut: false,
    desktopBusy: false,
    contextBudgetExhausted: false,
    businessVerified: false,
    policyDenials: [],
    calls: new Map(),
  }
}

function textFromMessage(message) {
  return (message.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export function reduceRunEvent(state, event) {
  const data = event.data
  if (event.type === 'assistant/message') {
    const text = textFromMessage(data.message)
    if (text) state.answer = text
  } else if (event.type === 'tool/call') {
    state.toolCalls += 1
    state.calls.set(data.callId, data.name)
    if (data.name.startsWith(CUA_TOOL_PREFIX)) {
      state.desktopToolCalls += 1
      const tool = data.name.slice(CUA_TOOL_PREFIX.length)
      if (mutationTools.has(tool)) {
        state.desktopMutationSeen = true
        state.interfaceVerified = false
      }
    }
  } else if (event.type === 'tool/result') {
    const name = state.calls.get(data.message.toolCallId)
    if (name?.startsWith(CUA_TOOL_PREFIX)) {
      const tool = name.slice(CUA_TOOL_PREFIX.length)
      if (data.message.isError) {
        const text = textFromMessage(data.message)
        if (text.includes('DESKTOP_BUSY')) state.desktopBusy = true
        if (text.includes('POLICY_DENIED')) {
          state.policyDenials.push({ tool, message: text.slice(0, 500) })
        }
      } else {
        state.desktopBusy = false
        if (state.desktopMutationSeen && OBSERVATION_TOOLS.has(tool)) state.interfaceVerified = true
      }
    }
  } else if (event.type === 'turn/end') {
    state.agentReason = data.reason
    if (data.reason?.kind === 'aborted'
      && data.reason.reason?.kind === 'hook'
      && data.reason.reason.reason === 'timeout') {
      state.timedOut = true
    }
  }
  return state
}

function taskStatus(state) {
  if (state.timedOut) return 'timeout'
  if (state.desktopBusy) return 'busy'
  if (!state.agentReason) return 'cancelled'
  if (state.agentReason.kind === 'aborted') return 'cancelled'
  if (state.agentReason.kind !== 'completed') return 'failed'
  if (state.contextBudgetExhausted) return 'failed'
  if (state.policyDenials.length > 0) return 'failed'
  if (state.businessVerified) return 'succeeded'
  return 'unverified'
}

function taskError(state, status) {
  if (status === 'timeout') return { code: 'TIMEOUT', message: 'task exceeded its time limit' }
  if (status === 'busy') return { code: 'DESKTOP_BUSY', message: 'another agent is operating this desktop' }
  if (status === 'cancelled') {
    return {
      code: 'CANCELLED',
      message: state.agentReason ? `agent turn ${state.agentReason.kind}` : 'agent stopped before a turn ended',
    }
  }
  if (status === 'failed' && state.contextBudgetExhausted) {
    return { code: 'CONTEXT_BUDGET_EXHAUSTED', message: 'desktop context budget exhausted; response is partial' }
  }
  if (status === 'failed' && state.policyDenials.length > 0) {
    return {
      code: 'POLICY_DENIED',
      message: `${state.policyDenials.length} desktop action(s) blocked by policy`,
    }
  }
  if (status === 'failed') return { code: 'AGENT_FAILED', message: `agent turn ended with ${state.agentReason.kind}` }
  return null
}

export function buildTaskResult(state, sessionId, artifactDir, startedAt) {
  const status = taskStatus(state)
  const verified = state.interfaceVerified && (status === 'unverified' || status === 'succeeded')
  return {
    taskId: sessionId,
    sessionId,
    status,
    answer: state.answer,
    agentReason: state.agentReason,
    verified,
    verification: {
      level: verified ? 'interface' : 'agent',
      interface: verified,
      business: state.businessVerified,
    },
    toolCalls: state.toolCalls,
    desktopToolCalls: state.desktopToolCalls,
    policy: { denials: state.policyDenials },
    cleanup: state.cleanup ?? null,
    error: taskError(state, status),
    artifactDir,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}