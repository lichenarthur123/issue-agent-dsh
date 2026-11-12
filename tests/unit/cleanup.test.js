import assert from 'node:assert/strict'
import test from 'node:test'
import { DesktopCleanup } from '../../packages/desktop-agent/src/cleanup.js'

const baseline = {
  apps: [{ pid: 100, bundle_id: 'com.apple.Chrome' }],
  windows: [{ pid: 100, window_id: 10 }],
}

function launchEvent(pid) {
  return {
    type: 'tool/result',
    data: {
      message: {
        toolCallId: 'launch-1',
        isError: false,
        content: [{ type: 'text', text: `Launched Calculator (pid ${pid})` }],
      },
    },
  }
}

function fixture(snapshots) {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: [call] }) => {
        calls.push({ ...call, arguments: JSON.parse(call.arguments) })
        const tool = call.name.replace('mcp__cua-driver-mcp__', '')
        const value = tool === 'get_accessibility_tree' ? snapshots.shift() : null
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const cleanup = new DesktopCleanup(ctx, { id: 'agent-test' })
  cleanup.observe({
    type: 'tool/call',
    data: { callId: 'launch-1', name: 'mcp__cua-driver-mcp__launch_app' },
  })
  return { cleanup, calls }
}

test('cleanup closes only new windows and newly launched apps', async () => {
  const { cleanup, calls } = fixture([
    baseline,
    {
      apps: [...baseline.apps, { pid: 200 }],
      windows: [...baseline.windows, { pid: 200, window_id: 11 }, { pid: 100, window_id: 12 }],
    },
    baseline,
  ])
  cleanup.observe(launchEvent(200))
  const report = await cleanup.restore()
  assert.equal(report.status, 'restored')
  assert.deepEqual(report.closedWindowIds, [12])
  assert.deepEqual(report.quitAppPids, [200])
  assert.deepEqual(calls.filter(call => call.name.endsWith('hotkey')).map(call => call.arguments.keys), [
    ['cmd', 'q'],
    ['cmd', 'w'],
  ])
})

test('an app that existed before the task is not quit', async () => {
  const { cleanup, calls } = fixture([baseline, baseline, baseline])
  cleanup.observe(launchEvent(100))
  const report = await cleanup.restore()
  assert.equal(report.status, 'restored')
  assert.equal(calls.some(call => call.arguments?.keys?.join('+') === 'cmd+q'), false)
})

test('remaining resources and unsaved prompts produce a partial report', async () => {
  const current = {
    apps: [...baseline.apps, { pid: 200 }],
    windows: [...baseline.windows, { pid: 200, window_id: 11 }],
  }
  const { cleanup } = fixture([baseline, current, current])
  cleanup.observe(launchEvent(200))
  const report = await cleanup.restore()
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.remainingWindowIds, [11])
  assert.deepEqual(report.remainingAppPids, [200])
})

test('restore runs only once', async () => {
  const { cleanup, calls } = fixture([baseline, baseline, baseline])
  await Promise.all([cleanup.restore(), cleanup.restore()])
  assert.equal(calls.filter(call => call.name.endsWith('get_accessibility_tree')).length, 3)
})
