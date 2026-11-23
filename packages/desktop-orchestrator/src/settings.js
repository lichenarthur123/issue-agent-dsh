import { resolve } from 'node:path'

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

export function resolveSettings(config = {}, env = process.env) {
  return {
    checkpointRoot: resolve(env.DESKTOP_ORCHESTRATOR_CHECKPOINT_ROOT ?? config.checkpointRoot ?? 'artifacts/long-tasks'),
    taskTimeoutMs: positiveInt(
      env.DESKTOP_ORCHESTRATOR_TIMEOUT_SECONDS,
      Number(config.taskTimeoutSeconds ?? 1800),
    ) * 1000,
    maxSubtasks: positiveInt(env.DESKTOP_ORCHESTRATOR_MAX_SUBTASKS, Number(config.maxSubtasks ?? 20)),
    maxTotalActions: positiveInt(env.DESKTOP_ORCHESTRATOR_MAX_TOTAL_ACTIONS, Number(config.maxTotalActions ?? 120)),
    cleanup: env.DESKTOP_ORCHESTRATOR_CLEANUP ?? config.cleanup ?? 'preserve',
    thinkingEffort: env.DESKTOP_ORCHESTRATOR_THINKING_EFFORT ?? config.thinkingEffort ?? 'low',
    supervisor: {
      provider: env.DESKTOP_ORCHESTRATOR_PROVIDER ?? config.supervisor?.provider ?? 'spark-executor',
      model: env.DESKTOP_ORCHESTRATOR_MODEL ?? config.supervisor?.model ?? 'qwen3.8-27b-nvfp4',
    },
  }
}
