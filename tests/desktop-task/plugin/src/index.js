import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const name = 'desktop-task-once'
export const inject = ['desktopTasks']

export function apply(ctx) {
  const taskFile = process.env.DESKTOP_TASK_FILE
  if (!taskFile) throw new Error('desktop-task-once: DESKTOP_TASK_FILE is required')
  const outFile = process.env.DESKTOP_TASK_OUT ? resolve(process.env.DESKTOP_TASK_OUT) : null
  const record = JSON.parse(readFileSync(taskFile, 'utf8'))
  if (!record?.issue || typeof record.issue.title !== 'string' || typeof record.issue.body !== 'string') {
    throw new Error('desktop-task-once: DESKTOP_TASK_FILE must contain issue.title and issue.body')
  }

  const keepAlive = setInterval(() => {}, 1 << 30)

  const finish = (payload, code) => {
    if (outFile) {
      mkdirSync(dirname(outFile), { recursive: true })
      writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n')
    }
    process.stdout.write(`desktop-task-once: ${payload.status ?? 'error'}${outFile ? ` ${outFile}` : ''}\n`)
    clearInterval(keepAlive)
    process.exitCode = code
    setTimeout(() => process.exit(code), 100).unref()
  }

  const startedAt = Date.now()
  console.error(`desktop-task-once: running ${record.issue.title}`)
  ;(async () => {
    try {
      const result = await ctx.desktopTasks.run(record)
      const code = result.status === 'succeeded' ? 0 : result.status === 'unverified' ? 2 : 1
      const payload = { ...result, taskFile, finishedAt: new Date().toISOString() }
      if (outFile) {
        mkdirSync(dirname(outFile), { recursive: true })
        writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n')
      }
      const idle = ctx.desktopTasks.whenMemoryIdle?.()
      if (idle) await Promise.race([idle, new Promise(resolve => setTimeout(resolve, 120000).unref())])
      finish(payload, code)
    } catch (error) {
      finish({
        status: 'error',
        answer: '',
        durationMs: Date.now() - startedAt,
        error: { code: 'RUNNER_ERROR', message: error?.message ?? String(error) },
        taskFile,
        finishedAt: new Date().toISOString(),
      }, 1)
    }
  })()
}