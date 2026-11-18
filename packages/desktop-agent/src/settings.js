import { resolve } from 'node:path'

function route(config, env, prefix, fallback) {
  return {
    provider: env[`DESKTOP_${prefix}_PROVIDER`] ?? config.provider ?? fallback.provider,
    model: env[`DESKTOP_${prefix}_MODEL`] ?? config.model ?? fallback.model,
  }
}

export function resolveDesktopSettings(config = {}, env = process.env) {
  const executor = route(config.executor ?? {}, env, 'EXECUTOR', {
    provider: 'spark-executor',
    model: 'qwen3.8-27b-nvfp4',
  })
  executor.coordinateSpace = env.DESKTOP_EXECUTOR_COORDINATE_SPACE
    ?? config.executor?.coordinateSpace
    ?? 'pixels'
  return {
    artifactRoot: resolve(env.AGENT_ARTIFACT_ROOT ?? config.artifactRoot ?? 'artifacts/native'),
    cwd: resolve(env.AGENT_CWD ?? config.cwd ?? process.cwd()),
    taskTimeoutMs: Number(env.AGENT_TASK_TIMEOUT_SECONDS ?? config.taskTimeoutSeconds ?? 600) * 1000,
    planner: route(config.planner ?? {}, env, 'PLANNER', {
      provider: 'spark-executor',
      model: 'qwen3.8-27b-nvfp4',
    }),
    executor,
    executorCoordinateSpace: executor.coordinateSpace,
    maxSteps: Number(env.DESKTOP_MAX_STEPS ?? config.maxSteps ?? 50),
    maxElements: Number(env.DESKTOP_MAX_ELEMENTS ?? config.maxElements ?? 300),
    observationMode: ['screenshot', 'hybrid'].includes(env.DESKTOP_OBSERVATION_MODE ?? config.observationMode)
      ? (env.DESKTOP_OBSERVATION_MODE ?? config.observationMode)
      : 'screenshot',
    thinkingEffort: env.DESKTOP_THINKING_EFFORT ?? config.thinkingEffort ?? 'low',
    thinkingMode: ['always', 'adaptive', 'off'].includes(env.DESKTOP_THINKING_MODE ?? config.thinkingMode)
      ? (env.DESKTOP_THINKING_MODE ?? config.thinkingMode)
      : 'always',
    groundingMode: ['auto', 'executor', 'grounder'].includes(env.DESKTOP_GROUNDING_MODE ?? config.groundingMode)
      ? (env.DESKTOP_GROUNDING_MODE ?? config.groundingMode)
      : 'auto',
    keepWindowsOnFailure: env.DESKTOP_KEEP_WINDOWS_ON_FAILURE === undefined
      ? config.keepWindowsOnFailure ?? false
      : env.DESKTOP_KEEP_WINDOWS_ON_FAILURE === 'true',
    grounder: {
      baseURL: (env.DESKTOP_GROUNDER_BASE_URL ?? config.grounder?.baseURL ?? 'http://10.10.10.1:8003/v1').replace(/\/+$/, ''),
      model: env.DESKTOP_GROUNDER_MODEL ?? config.grounder?.model ?? 'ui-tars-1.5-7b',
    },
  }
}
