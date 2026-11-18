import { compactHistory } from './history.js'
import { logModelEnd, logModelStart } from './log.js'
import { parsePlannerDecision } from './planner.js'
import { budgetBytes, SCREENSHOT_PROMPT_BUDGET } from './prompt-budget.js'
import { buildExecutorPrompt, executorSystem } from './prompt.js'

export class Executor {
  constructor(ctx, selection, { thinkingEffort = 'medium', observationMode = 'hybrid', coordinateSpace = 'pixels' } = {}) {
    this.ctx = ctx
    this.selection = selection
    this.thinkingEffort = thinkingEffort
    this.observationMode = observationMode
    this.coordinateSpace = coordinateSpace
    const system = executorSystem(observationMode, coordinateSpace)
    this.system = observationMode === 'screenshot'
      ? budgetBytes(system, SCREENSHOT_PROMPT_BUDGET.systemBytes)
      : system
  }

  async decide({
    request,
    plan,
    history = [],
    observation = null,
    pageTarget = null,
    targetWindow = null,
    feedback = null,
    feedbackHistory = [],
    thinking = false,
    signal,
  }) {
    const content = [{
      type: 'text',
      text: buildExecutorPrompt({
        request,
        plan,
        history,
        observation,
        pageTarget,
        targetWindow,
        feedback,
        feedbackHistory,
        observationMode: this.observationMode,
      }),
    }]
    if (observation?.data) {
      const image = await this.ctx.attachments.saveImage({
        data: observation.data,
        mediaType: observation.ref.mediaType,
      })
      content.push({ type: 'image', attachment: image })
    }
    let text = ''
    let failure
    let usage = {}
    const historyBytes = Buffer.byteLength(JSON.stringify(compactHistory(history)))
    const userBytes = Buffer.byteLength(content[0].text)
    const startedAt = logModelStart(this.selection, {
      thinking,
      parts: {
        sys: Buffer.byteLength(this.system),
        user: Math.max(0, userBytes - historyBytes),
        history: historyBytes,
        image: observation?.data?.byteLength ?? 0,
      },
    })
    for await (const chunk of this.ctx.llm.stream({
      ...this.selection,
      ...thinking ? { reasoningEffort: this.thinkingEffort } : {},
      messages: [
        { role: 'system', content: [{ type: 'text', text: this.system }] },
        { role: 'user', content },
      ],
      maxTokens: 6000,
      temperature: 0,
      signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') failure = chunk.reason
    }
    logModelEnd(this.selection, startedAt, usage, text)
    if (failure?.kind === 'error') throw new Error(failure.failure?.message ?? 'executor failed')
    if (failure?.kind === 'aborted') throw new Error('executor was cancelled')
    return parsePlannerDecision(text)
  }
}
