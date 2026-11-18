export const PROMPT_LIMITS = Object.freeze({
  task: 8000,
  plan: 12000,
  installedApps: 3000,
  ax: 12000,
  axContext: 2000,
  verifierAx: 8000,
  historySummary: 2400,
  historyAction: 300,
  historyTarget: 200,
  historyUrl: 500,
  historyValue: 1000,
  historyResult: 300,
  historyError: 800,
  feedbackCurrent: 1200,
  feedbackPast: 500,
  feedbackPastCount: 5,
})

export function clip(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

export function budgetText(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[truncated: showing first ${limit} of ${text.length} characters]`
}

export const SCREENSHOT_PROMPT_BUDGET = Object.freeze({
  systemBytes: 4800,
  userBytes: 3000,
  historyBytes: 1500,
})

export function textBytes(value) {
  return Buffer.byteLength(String(value ?? ''))
}

export function truncateBytes(value, maxBytes) {
  const text = String(value ?? '')
  if (maxBytes <= 0) return ''
  let bytes = 0
  let result = ''
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > maxBytes) break
    result += char
    bytes += size
  }
  return result
}

export function budgetBytes(value, maxBytes) {
  const text = String(value ?? '')
  const originalBytes = textBytes(text)
  if (originalBytes <= maxBytes) return text
  if (maxBytes <= 0) return ''
  const marker = `\n[truncated: ${originalBytes} bytes total]`
  const result = `${truncateBytes(text, Math.max(0, maxBytes - textBytes(marker)))}${marker}`
  return textBytes(result) <= maxBytes ? result : truncateBytes(result, maxBytes)
}
