import { budgetBytes, clip, PROMPT_LIMITS, textBytes } from './prompt-budget.js'

export const RECENT_HISTORY_LIMIT = 5

export function compactHistory(history = [], { limit = RECENT_HISTORY_LIMIT, brief = false } = {}) {
  return history.slice(-limit).map(step => {
    const action = step.action ?? {}
    if (brief) {
      return {
        step: step.step,
        action: {
          kind: action.kind ?? 'action',
          action: clip(action.action ?? '', 120),
        },
        result: {
          status: step.result?.status ?? 'unknown',
          ...step.result?.summary ? { summary: clip(step.result.summary, 120) } : {},
        },
      }
    }
    return {
      step: step.step,
      action: {
        kind: action.kind ?? 'action',
        action: clip(action.action ?? '', PROMPT_LIMITS.historyAction),
        ...action.url ? { url: clip(action.url, PROMPT_LIMITS.historyUrl) } : {},
        ...action.target ? { target: clip(action.target, PROMPT_LIMITS.historyTarget) } : {},
        ...action.value ? { value: clip(action.value, PROMPT_LIMITS.historyValue) } : {},
        ...action.locate && action.locate !== 'ax' ? { locate: action.locate } : {},
      },
      result: {
        status: step.result?.status ?? 'unknown',
        ...step.result?.summary ? { summary: clip(step.result.summary, PROMPT_LIMITS.historyResult) } : {},
        ...step.result?.error ? { error: clip(step.result.error, PROMPT_LIMITS.historyError) } : {},
      },
    }
  })
}

export function summarizeHistory(history = [], { limit = RECENT_HISTORY_LIMIT, maxChars = PROMPT_LIMITS.historySummary } = {}) {
  if (history.length <= limit) return null
  const omitted = history.slice(0, -limit)
  const lines = omitted.map(step => {
    const action = step.action ?? {}
    const label = clip(action.action || [action.kind, action.target].filter(Boolean).join(' '), 120)
    const status = step.result?.status ?? 'unknown'
    return [`#${step.step} ${action.kind ?? 'action'}`, label, `-> ${status}`].filter(Boolean).join(' ')
  })
  const text = lines.join('\n')
  if (text.length <= maxChars) {
    return { text, omittedCount: omitted.length, truncated: false }
  }
  const kept = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = [lines[index], ...kept].join('\n')
    if (candidate.length > maxChars) break
    kept.unshift(lines[index])
  }
  const dropped = lines.length - kept.length
  return {
    text: [`... ${dropped} earlier steps not shown`, ...kept].join('\n'),
    omittedCount: omitted.length,
    truncated: true,
  }
}

function renderHistoryCandidate(history, { limit, summary, brief }) {
  const omittedCount = Math.max(0, history.length - limit)
  const lines = [`<history>${JSON.stringify(compactHistory(history, { limit, brief }))}</history>`]
  if (omittedCount > 0) {
    const historySummary = summary ? summarizeHistory(history, { limit }) : null
    if (historySummary) {
      lines.push(`<history-summary>${historySummary.text}</history-summary>`)
      lines.push(`<history-omitted>${historySummary.omittedCount} earlier steps are summarized above; only the latest ${limit} are shown in full.</history-omitted>`)
    } else {
      lines.push(`<history-omitted>${omittedCount} earlier steps are omitted; only the latest ${limit} are shown.</history-omitted>`)
    }
  }
  return lines.join('\n')
}

export function renderHistory(history = [], { maxBytes = Number.POSITIVE_INFINITY } = {}) {
  const candidates = [
    { limit: RECENT_HISTORY_LIMIT, summary: true, brief: false },
    { limit: RECENT_HISTORY_LIMIT, summary: false, brief: false },
    { limit: 3, summary: false, brief: false },
    { limit: 3, summary: false, brief: true },
    { limit: 1, summary: false, brief: true },
  ]
  let text = ''
  for (const candidate of candidates) {
    text = renderHistoryCandidate(history, candidate)
    if (textBytes(text) <= maxBytes) return text
  }
  return budgetBytes(text, maxBytes)
}
