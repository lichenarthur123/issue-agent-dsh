const COLORS = {
  plan: ['\u001b[34m', '◆ PLAN'],
  exec: ['\u001b[32m', '▶ EXEC'],
  ground: ['\u001b[33m', '⌖ GROUND'],
  verify: ['\u001b[35m', '✓ VERIFY'],
  model: ['\u001b[36m', '◈ MODEL'],
  error: ['\u001b[31m', '✕ ERROR'],
}

export function compact(value, limit = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function logNode(kind, value, limit = 180) {
  const [color, label] = COLORS[kind] ?? COLORS.exec
  const text = `${new Date().toISOString()} ${compact(value, limit)}`
  console.error(process.stderr.isTTY && !process.env.NO_COLOR ? `${color}${label}\u001b[0m ${text}` : `${label} ${text}`)
}

export function modelName(selection) {
  return selection?.model ?? 'unknown-model'
}

export function formatInputParts(parts) {
  if (!parts) return ''
  return Object.entries(parts)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([key, value]) => `${key}=${value}B`)
    .join(' ')
}

export function logModelStart(selection, { thinking = false, parts = null } = {}) {
  const suffix = formatInputParts(parts)
  logNode('model', `call ${modelName(selection)}${thinking ? ' thinking' : ''}${suffix ? ` | ${suffix}` : ''}`)
  return Date.now()
}

export function formatModelResponse(content) {
  if (typeof content === 'string') return content
  return (content ?? []).map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'tool-call') {
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
      return `${block.name}(${args})`
    }
    return JSON.stringify(block)
  }).filter(Boolean).join('\n')
}

export function logModelResponse(selection, content) {
  logNode('model', `${modelName(selection)} response=${formatModelResponse(content)}`, Number.POSITIVE_INFINITY)
}

export function logModelEnd(selection, startedAt, usage = {}, response) {
  const cacheRead = usage.cacheReadTokens ?? usage.cacheRead ?? usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? usage.cacheWrite ?? 0
  // DSH reports inputTokens with the cached prefix already subtracted; raw OpenAI
  // usage reports prompt_tokens as the whole prompt. Keep input as the full prompt size.
  const input = usage.inputTokens !== undefined
    ? usage.inputTokens + cacheRead + cacheWrite
    : (usage.prompt_tokens ?? 0)
  const output = usage.outputTokens ?? usage.completion_tokens ?? 0
  const cache = ` cache=${cacheRead}${cacheWrite > 0 ? ` cacheWrite=${cacheWrite}` : ''}`
  logNode('model', `${modelName(selection)} input=${input}${cache} output=${output} time=${Date.now() - startedAt}ms`)
  if (response !== undefined) logModelResponse(selection, response)
}

export const log = {
  plan: value => logNode('plan', value),
  exec: value => logNode('exec', value),
  ground: value => logNode('ground', value),
  verify: value => logNode('verify', value),
  error: value => logNode('error', value),
}
