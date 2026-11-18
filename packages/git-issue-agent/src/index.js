import { GitHubIssues } from './github.js'
import { acquireInstanceLock } from './lock.js'
import { IssuePoller } from './poller.js'
import { resolveSettings, settingsProblems } from './settings.js'
import { IssueStore } from './store.js'

export const name = 'git-issue-agent'
export const inject = ['desktopTasks']

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const problems = settingsProblems(settings)
  if (problems.length) throw new Error(`git-issue-agent: ${problems.join('; ')}`)

  const release = acquireInstanceLock(settings.stateDir)
  const github = new GitHubIssues(settings)
  const store = new IssueStore(settings.stateDir)
  const runner = {
    run: record => ctx.desktopTasks.run(record),
    stop: () => ctx.desktopTasks.stop(),
  }
  const poller = new IssuePoller({ settings, github, runner, store })
  poller.start()

  console.error(
    `git-issue-agent: watching ${settings.repository} every ${settings.pollIntervalMs / 1000}s; label=${settings.triggerLabel}; polling uses no LLM`,
  )
  ctx.effect(() => async () => {
    await poller.stop()
    release()
  })
}
