import { resolve } from 'node:path'

function route(config, env, prefix, fallback) {
  return {
    provider: env[`DESKTOP_${prefix}_PROVIDER`] ?? config.provider ?? fallback.provider,
    model: env[`DESKTOP_${prefix}_MODEL`] ?? config.model ?? fallback.model,
  }
}

export function resolveDesktopSettings(config = {}, env = process.env) {
  const browserProfileMode = env.DESKTOP_BROWSER_PROFILE_MODE ?? config.browserProfileMode ?? 'existing_profile'
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
    plannerEnabled: env.DESKTOP_PLANNER_ENABLED === undefined
      ? config.plannerEnabled ?? false
      : env.DESKTOP_PLANNER_ENABLED === 'true',
    browserProfile: {
      mode: ['isolated_new', 'isolated_named', 'existing_profile'].includes(browserProfileMode)
        ? browserProfileMode
        : 'existing_profile',
      name: env.DESKTOP_BROWSER_PROFILE_NAME ?? config.browserProfileName ?? 'issue-agent',
      app: env.BROWSER_APP ?? config.browserApp ?? 'Google Chrome',
      lang: env.BROWSER_LANG ?? config.browserLang ?? 'en-US',
    },
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
