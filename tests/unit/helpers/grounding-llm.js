export function groundingLlm(...answers) {
  const queue = answers.length === 1 && Array.isArray(answers[0]) ? [...answers[0]] : [...answers]
  const calls = []
  return {
    calls,
    async *stream(request) {
      calls.push(request)
      const next = queue.length > 1 ? queue.shift() : queue[0]
      const answer = typeof next === 'function' ? next(request) : next
      if (answer === undefined) throw new Error('grounder answers exhausted')
      yield { type: 'text-delta', text: answer }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  }
}

export function groundingAttachments() {
  return {
    saveImage: async ({ data, mediaType }) => ({ mediaType, bytes: data?.byteLength ?? 0 }),
  }
}