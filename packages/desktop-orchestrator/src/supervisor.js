import { buildSupervisorPrompt, SUPERVISOR_SYSTEM } from './prompt.js'

function parseDecision(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('supervisor returned no JSON object')
  const decision = JSON.parse(text.slice(start, end + 1))
  if (decision.status === 'continue') {
    if (!decision.instruction?.trim() || !decision.successEvidence?.trim()) {
      throw new Error('continue requires instruction and successEvidence')
    }
    return {
      status: 'continue',
      instruction: decision.instruction.trim(),
      successEvidence: decision.successEvidence.trim(),
      maxActions: Math.min(Math.max(Number(decision.maxActions) || 6, 1), 12),
    }
  }
  if (decision.status === 'done' && decision.response?.trim()) {
    return { status: 'done', response: decision.response.trim() }
  }
  if (decision.status === 'blocked' && decision.reason?.trim()) {
    return { status: 'blocked', reason: decision.reason.trim() }
  }
  throw new Error('supervisor returned an invalid decision')
}

export class Supervisor {
  constructor({ llm, attachments, selection, thinkingEffort = 'low' }) {
    this.llm = llm
    this.attachments = attachments
    this.selection = selection
    this.thinkingEffort = thinkingEffort
  }

  async decide({ goal, checkpoints, observation, lastFeedback, signal }) {
    const content = [{
      type: 'text',
      text: buildSupervisorPrompt({ goal, checkpoints, observation, lastFeedback }),
    }]
    if (observation?.data) {
      const image = await this.attachments.saveImage({
        data: observation.data,
        mediaType: observation.ref.mediaType,
      })
      content.push({ type: 'image', attachment: image })
    }
    let text = ''
    let failure
    for await (const chunk of this.llm.stream({
      ...this.selection,
      reasoningEffort: this.thinkingEffort,
      messages: [
        { role: 'system', content: [{ type: 'text', text: SUPERVISOR_SYSTEM }] },
        { role: 'user', content },
      ],
      maxTokens: 2000,
      temperature: 0,
      signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') failure = chunk.reason
    }
    if (failure?.kind === 'error') throw new Error(failure.failure?.message ?? 'supervisor failed')
    if (failure?.kind === 'aborted') throw new Error('supervisor was cancelled')
    return parseDecision(text)
  }
}
