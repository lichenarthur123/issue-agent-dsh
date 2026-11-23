export function taskGoal(record) {
  return [record?.issue?.title, record?.issue?.body]
    .filter(value => typeof value === 'string' && value.trim())
    .join('\n\n')
    .trim()
}

export function taskResult({
  runId,
  status,
  answer = '',
  checkpointDir,
  steps = 0,
  totalActions = 0,
  startedAt,
  error = null,
}) {
  return {
    runId,
    status,
    answer,
    checkpointDir,
    steps,
    totalActions,
    error,
    durationMs: Date.now() - startedAt,
  }
}
