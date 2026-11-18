import { clip, PROMPT_LIMITS } from './prompt-budget.js'

function promptFeedback(value, limit) {
  if (!value) return null
  return {
    status: value.status ?? 'unknown',
    reason: clip(value.reason ?? '', limit),
  }
}

export class FeedbackLog {
  constructor({ maxPast = PROMPT_LIMITS.feedbackPastCount } = {}) {
    this.maxPast = maxPast
    this.active = null
    this.past = []
  }

  get current() {
    return this.active
  }

  set(value) {
    if (!value) return
    if (this.active) this.archive()
    this.active = {
      status: value.status ?? 'unknown',
      reason: String(value.reason ?? ''),
    }
  }

  merge(note) {
    const text = String(note ?? '').trim()
    if (!text) return
    if (!this.active) {
      this.set({ status: 'no-progress', reason: text })
      return
    }
    this.active = { ...this.active, reason: `${this.active.reason} ${text}` }
  }

  consume() {
    if (!this.active) return
    this.archive()
    this.active = null
  }

  archive() {
    this.past.push(this.active)
    if (this.past.length > this.maxPast) this.past.splice(0, this.past.length - this.maxPast)
  }

  snapshot() {
    return {
      feedback: promptFeedback(this.active, PROMPT_LIMITS.feedbackCurrent),
      feedbackHistory: this.past.map(item => promptFeedback(item, PROMPT_LIMITS.feedbackPast)),
    }
  }
}
