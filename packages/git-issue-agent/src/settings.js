import { resolve } from 'node:path'

function numberFrom(value, fallback, minimum) {
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum ? number : fallback
}

export function resolveSettings(config = {}, env = process.env) {
  return {
    repository: env.GITHUB_REPOSITORY ?? config.repository ?? '',
    apiBase: (env.GITHUB_API_BASE ?? config.apiBase ?? 'https://api.github.com').replace(/\/+$/, ''),
    token: env.GITHUB_TOKEN ?? '',
    triggerLabel: env.GITHUB_TRIGGER_LABEL ?? config.triggerLabel ?? 'agent:desktop',
    pollIntervalMs: numberFrom(
      env.GITHUB_POLL_INTERVAL_SECONDS,
      Number(config.pollIntervalSeconds ?? 60),
      5,
    ) * 1000,
    maxIssuesPerPoll: numberFrom(
      env.GITHUB_MAX_ISSUES_PER_POLL,
      Number(config.maxIssuesPerPoll ?? 20),
      1,
    ),
    stateDir: resolve(env.AGENT_STATE_DIR ?? config.stateDir ?? 'artifacts/issue-agent'),
  }
}

export function settingsProblems(settings) {
  const problems = []
  if (!/^[\w.-]+\/[\w.-]+$/.test(settings.repository)) {
    problems.push('GITHUB_REPOSITORY must be owner/repo')
  }
  if (!settings.token) problems.push('GITHUB_TOKEN is required for polling and issue comments')
  if (!settings.triggerLabel.trim()) problems.push('GITHUB_TRIGGER_LABEL must not be empty')
  return problems
}
