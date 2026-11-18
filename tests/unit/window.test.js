import assert from 'node:assert/strict'
import test from 'node:test'
import { callCuaTool, ensureWindowVisible } from '../../packages/desktop-agent/src/window.js'

function harness(handler) {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        calls.push({ name: call.name, args: JSON.parse(call.arguments) })
        return handler(call)
      },
    },
  }
  return { ctx, calls }
}

test('an ended session is revived and the call retried', async () => {
  let attempts = 0
  const { ctx, calls } = harness(call => {
    const name = call.name.replace('mcp__cua-driver-mcp__', '')
    if (name === 'get_window_state') {
      attempts += 1
      if (attempts === 1) {
        return { results: [{ result: { isError: true, content: [{ type: 'text', text: "Error: session 'mcp-1' has ended; tool call 'get_window_state' was rejected." }] } }] }
      }
      return { results: [{ result: { isError: false, value: { ok: true } } }] }
    }
    return { results: [{ result: { isError: false, value: {} } }] }
  })
  const value = await callCuaTool(ctx, {}, 'get_window_state', { pid: 1, window_id: 2 })
  assert.deepEqual(value, { ok: true })
  assert.equal(attempts, 2)
  assert.deepEqual(calls[1], { name: 'mcp__cua-driver-mcp__start_session', args: { session: 'mcp-1' } })
})

test('other tool errors are not revived', async () => {
  let startSessionCalls = 0
  const { ctx } = harness(call => {
    if (call.name.endsWith('start_session')) startSessionCalls += 1
    return { results: [{ result: { isError: true, content: [{ type: 'text', text: 'Error: unknown window_id 2' }] } }] }
  })
  await assert.rejects(callCuaTool(ctx, {}, 'get_window_state', { pid: 1, window_id: 2 }), /unknown window_id/)
  assert.equal(startSessionCalls, 0)
})

test('an unverifiable window is moved onto the main display before retrying', async () => {
  let frontAttempts = 0
  const { ctx, calls } = harness(call => {
    const name = call.name.replace('mcp__cua-driver-mcp__', '')
    if (name === 'bring_to_front') {
      frontAttempts += 1
      if (frontAttempts <= 2) {
        return { results: [{ result: { isError: false, value: { exact_window_effect: { verified: false } } } }] }
      }
    }
    if (name === 'get_screen_size') {
      return { results: [{ result: { isError: false, value: { width: 1512, height: 982 } } }] }
    }
    return { results: [{ result: { isError: false, value: { activated: true, exact_window_effect: { verified: true } } } }] }
  })
  await ensureWindowVisible(ctx, {}, { pid: 11879, window_id: 20614 }, {
    reactivate: async () => { throw new Error('no bundle id is known for pid 11879') },
  })
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__bring_to_front',
    'mcp__cua-driver-mcp__bring_to_front',
    'mcp__cua-driver-mcp__get_screen_size',
    'mcp__cua-driver-mcp__set_window_frame',
    'mcp__cua-driver-mcp__bring_to_front',
  ])
  assert.deepEqual(calls[3].args, { pid: 11879, window_id: 20614, x: 151, y: 98, width: 1210, height: 786 })
})

test('a minimized window is restored by reactivating its application', async () => {
  let frontAttempts = 0
  let reactivations = 0
  const { ctx, calls } = harness(call => {
    if (call.name.endsWith('bring_to_front')) {
      frontAttempts += 1
      if (frontAttempts === 1) {
        return { results: [{ result: { isError: false, value: { activated: false } } }] }
      }
    }
    return { results: [{ result: { isError: false, value: { activated: true, exact_window_effect: { verified: true } } } }] }
  })
  await ensureWindowVisible(ctx, {}, { pid: 85726, window_id: 8228 }, {
    reactivate: async () => { reactivations += 1 },
  })
  assert.equal(reactivations, 1)
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__bring_to_front',
    'mcp__cua-driver-mcp__bring_to_front',
  ])
})

test('reactivation asks the driver for the application bundle id', async () => {
  let frontAttempts = 0
  const { ctx, calls } = harness(call => {
    const name = call.name.replace('mcp__cua-driver-mcp__', '')
    if (name === 'bring_to_front') {
      frontAttempts += 1
      if (frontAttempts === 1) {
        return { results: [{ result: { isError: false, value: { activated: false } } }] }
      }
    }
    return { results: [{ result: { isError: false, value: { activated: true, exact_window_effect: { verified: true } } } }] }
  })
  await ensureWindowVisible(ctx, {}, { pid: 85726, window_id: 8228 })
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__bring_to_front',
    'mcp__cua-driver-mcp__list_apps',
    'mcp__cua-driver-mcp__bring_to_front',
  ])
})

test('a window that stays hidden fails loudly', async () => {
  const { ctx } = harness(() => ({
    results: [{ result: { isError: false, value: { activated: false } } }],
  }))
  await assert.rejects(
    ensureWindowVisible(ctx, {}, { pid: 11879, window_id: 20614 }),
    /could not be made visible|not verified as visible/,
  )
})

test('a visible window under a same-app popup is accepted without repair', async () => {
  const { ctx, calls } = harness(() => ({
    results: [{
      result: {
        isError: false,
        value: {
          activated: false,
          exact_window_effect: {
            focused: true,
            frontmost_ordinary: false,
            target_visible_ordinary: true,
            verified: false,
          },
          observed: { front_process_matches_target: true, frontmost_ordinary_window_id: 21449 },
        },
      },
    }],
  }))
  await ensureWindowVisible(ctx, {}, { pid: 85726, window_id: 8228 })
  assert.deepEqual(calls.map(call => call.name), ['mcp__cua-driver-mcp__bring_to_front'])
})
