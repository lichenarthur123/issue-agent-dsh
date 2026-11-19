import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compactHistory } from './history.js'
import { log, logModelEnd, logModelStart } from './log.js'
import { budgetBytes } from './prompt-budget.js'

const MEMORY_SYSTEM = [
  'Maintain a reusable desktop-operation playbook from execution histories.',
  'Return only Markdown: one short title line starting with "#", then at most 20 bullet points.',
  'When previous experience is provided, merge it with the new lessons: keep the most reusable points, merge near-duplicates, remove anything contradicted by the new run, and never exceed 20 bullets.',
  'Prefer 10-15 high-value bullets; do not pad the list to the limit.',
  'If the execution failed, blocked, or timed out, record the failure mode and a safer approach instead of the failed values.',
  'Generalize across tasks. Do not include business values, record identifiers, URLs, credentials, personal data, or exact task answers.',
  'Each bullet must be one line under 120 characters and describe a reusable action, observation, verification, or recovery pattern.',
].join('\n')

function hostOf(value) {
  const match = /https?:\/\/[^\s/"'<>]+/i.exec(String(value ?? ''))
  if (!match) return ''
  try {
    return new URL(match[0]).host.toLowerCase()
  } catch {
    return ''
  }
}

function sanitize(value) {
  return String(value ?? '')
    .replace(/```(?:markdown|md)?/gi, '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:bearer\s+)[a-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_ -]?key|token|password|cookie)\b\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[redacted]')
    .replace(/(?<!\d)1\d{10}(?!\d)/g, '[redacted]')
    .trim()
}

function bodyOf(text) {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(text)
  return (match ? match[1] : text).trim()
}

function runsOf(text) {
  const match = /^---\n[\s\S]*?\bruns:\s*(\d+)[\s\S]*?\n---\n/.exec(text)
  return Number(match?.[1]) || 0
}

function normalizeMarkdown(value, maxLessons, maxBytes) {
  const lines = String(value ?? '').split('\n')
  const titleIndex = lines.findIndex(line => /^#\s+\S/.test(line.trim()))
  if (titleIndex < 0) return ''
  const title = lines[titleIndex].trim()
  const bullets = []
  let inFence = false
  for (const line of lines.slice(titleIndex + 1)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(trimmed)
    if (!match) continue
    const item = match[1].replace(/\s+/g, ' ').trim()
    if (!item) continue
    bullets.push(`- ${item}`)
    if (bullets.length >= maxLessons) break
  }
  if (bullets.length === 0) return ''
  return budgetBytes([title, '', ...bullets].join('\n'), maxBytes)
}

export class LocalMemory {
  constructor({ enabled = false, root = 'memory', maxLessons = 20, maxBytes = 2400 } = {}) {
    this.enabled = enabled
    this.root = resolve(root)
    this.file = join(this.root, 'experience.md')
    this.maxLessons = maxLessons
    this.maxBytes = maxBytes
  }

  contextFor() {
    if (!this.enabled || !existsSync(this.file)) return ''
    let text
    try {
      text = budgetBytes(sanitize(bodyOf(readFileSync(this.file, 'utf8'))), this.maxBytes)
    } catch {
      return ''
    }
    if (!text) return ''
    const lessons = text.split('\n').filter(line => /^[-*]\s+/.test(line)).length
    log.exec(`memory loaded lessons=${lessons}`)
    return text
  }

  async learn(ctx, selection, { history = [], url = '', status = 'succeeded' } = {}) {
    if (!this.enabled || history.length === 0) return null
    const compact = compactHistory(history, { limit: 30, brief: true })
    const previousText = existsSync(this.file) ? readFileSync(this.file, 'utf8') : ''
    const previous = bodyOf(previousText)
    const userText = [
      `<outcome>${status}</outcome>`,
      `<host>${hostOf(url)}</host>`,
      ...previous ? ['<previous-experience>', previous, '</previous-experience>'] : [],
      `<history>${JSON.stringify(compact)}</history>`,
    ].join('\n')
    let response = ''
    let failure
    let usage = {}
    const startedAt = logModelStart(selection, {
      parts: { sys: Buffer.byteLength(MEMORY_SYSTEM), user: Buffer.byteLength(userText) },
    })
    for await (const chunk of ctx.llm.stream({
      ...selection,
      reasoningEffort: 'off',
      messages: [
        { role: 'system', content: [{ type: 'text', text: MEMORY_SYSTEM }] },
        { role: 'user', content: [{ type: 'text', text: userText }] },
      ],
      maxTokens: 1200,
      temperature: 0,
    })) {
      if (chunk.type === 'text-delta') response += chunk.text
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') failure = chunk.reason
    }
    logModelEnd(selection, startedAt, usage, response)
    if (failure?.kind === 'error') throw new Error(failure.failure?.message ?? 'memory summarization failed')
    if (failure?.kind === 'aborted') throw new Error('memory summarization was cancelled')
    const body = normalizeMarkdown(sanitize(response), this.maxLessons, this.maxBytes)
    if (!body) throw new Error('memory summarization returned no usable Markdown')

    const lessons = body.split('\n').filter(line => /^[-*]\s+/.test(line)).length
    const metadata = [
      '---',
      'app: Chrome',
      `runs: ${runsOf(previousText) + 1}`,
      `lessons: ${lessons}`,
      `updatedAt: ${new Date().toISOString()}`,
      '---',
    ].join('\n')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${metadata}\n${body}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
    log.exec(`memory saved lessons=${lessons}: ${this.file}`)
    return this.file
  }
}