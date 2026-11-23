import { LongTaskRunner } from './runner.js'
import { resolveSettings } from './settings.js'

export const name = 'desktop-orchestrator'
export const inject = ['desktopTasks', 'llm', 'attachments']

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const runner = new LongTaskRunner({
    desktopTasks: ctx.desktopTasks,
    llm: ctx.llm,
    attachments: ctx.attachments,
    settings,
  })
  ctx.reflect.provide('desktopWorkflows', runner)
  ctx.effect(() => () => runner.stopAll())
}
