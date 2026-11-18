import { log, logModelEnd, logModelStart } from './log.js'
import { extractJsonObject } from './planner.js'
import { budgetText, clip, PROMPT_LIMITS } from './prompt-budget.js'

const VERIFY_SYSTEM = [
  'Verify a desktop task outcome using only the expected state and the supplied screenshot and AX text.',
  'Return only JSON with status and reason. status is passed, failed, or unverified.',
  'Do not infer success from the fact that an action was executed. Use unverified when evidence is insufficient.',
].join('\n')

export class VlVerifier {
  constructor(ctx, selection) {
    this.ctx = ctx
    this.selection = selection
  }

  async verify(decision, observation, signal) {
    const image = await this.ctx.attachments.saveImage({
      data: observation.data,
      mediaType: observation.ref.mediaType,
    })
    let text = ''
    let failure
    let usage = {}
    const userText = `Step: ${clip(decision.action, PROMPT_LIMITS.historyAction)}\nExpected: ${budgetText(decision.verification, PROMPT_LIMITS.task)}\nAX:\n${budgetText(observation.text, PROMPT_LIMITS.verifierAx)}`
    const startedAt = logModelStart(this.selection, {
      parts: {
        sys: Buffer.byteLength(VERIFY_SYSTEM),
        user: Buffer.byteLength(userText),
        image: observation.data?.byteLength ?? 0,
      },
    })
    for await (const chunk of this.ctx.llm.stream({
      ...this.selection,
      messages: [
        { role: 'system', content: [{ type: 'text', text: VERIFY_SYSTEM }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image', attachment: image },
          ],
        },
      ],
      maxTokens: 800,
      signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') failure = chunk.reason
    }
    logModelEnd(this.selection, startedAt, usage, text)
    if (failure?.kind === 'error') throw new Error(failure.failure?.message ?? 'verifier failed')
    if (failure?.kind === 'aborted') throw new Error('verifier was cancelled')
    let result
    try {
      result = extractJsonObject(text)
    } catch {
      log.verify('unverified: no JSON result')
      return { status: 'unverified', reason: 'verifier returned no JSON object' }
    }
    if (!['passed', 'failed', 'unverified'].includes(result.status)) {
      log.verify(`unverified: invalid status ${result.status}`)
      return { status: 'unverified', reason: 'verifier returned an invalid status' }
    }
    log.verify(`${result.status}: ${result.reason}`)
    return { status: result.status, reason: String(result.reason ?? '') }
  }

  async verifyCompletion(record, observation, signal) {
    const expected = [record.issue.title, record.issue.body].filter(Boolean).join('\n\n').trim()
    return this.verify({
      action: 'Complete the original task',
      verification: expected,
    }, observation, signal)
  }
}
