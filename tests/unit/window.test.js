import assert from 'node:assert/strict'
import test from 'node:test'
import { callCuaTool, captureWindow, ensureWindowVisible, renderElements } from '../../packages/desktop-agent/src/window.js'

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

test('AX rendering keeps actionable controls and a small amount of context', () => {
  const text = renderElements([
    { element_index: 0, role: 'AXWindow', label: 'SKU 上架' },
    { element_index: 1, role: 'AXButton', label: '保存', element_token: 's:1', frame: { x: 1, y: 2, w: 50, h: 20 } },
    { element_index: 2, role: 'AXStaticText', label: '保存成功', frame: { x: 1, y: 40, w: 100, h: 20 } },
    { element_index: 3, role: 'AXTextField', label: '商品名称', value: '成人纸尿裤', element_token: 's:3', focused: true },
    { element_index: 4, role: 'AXButton', label: '隐藏按钮', element_token: 's:4', hidden: true },
    { element_index: 5, role: 'AXButton', label: '无 token 按钮' },
    { element_index: 6, role: 'AXStaticText', label: '可点击文本', element_token: 's:6', actions: ['AXPress'] },
  ])
  assert.match(text, /Controls:/)
  assert.match(text, /Button "保存"/)
  assert.match(text, /TextField "商品名称" value="成人纸尿裤" focused/)
  assert.match(text, /StaticText "可点击文本"/)
  assert.match(text, /Context:/)
  assert.match(text, /Window "SKU 上架"/)
  assert.match(text, /保存成功/)
  assert.doesNotMatch(text, /隐藏按钮/)
  assert.doesNotMatch(text, /无 token 按钮/)
})

test('AX rendering enforces its budget and reports omitted controls', () => {
  const elements = Array.from({ length: 100 }, (_, index) => ({
    element_index: index,
    role: 'AXButton',
    label: `按钮${index}`,
    element_token: `s:${index}`,
  }))
  const text = renderElements(elements, { maxChars: 300, contextMaxChars: 100 })
  assert.ok(text.length <= 300)
  assert.match(text, /\.\.\. omitted \d+ controls/)
})

test('AX rendering deduplicates identical controls but preserves distinct positions', () => {
  const text = renderElements([
    { element_index: 1, role: 'AXButton', label: '删除', element_token: 's:1', frame: { x: 0, y: 0, w: 40, h: 20 } },
    { element_index: 2, role: 'AXButton', label: '删除', element_token: 's:2', frame: { x: 0, y: 0, w: 40, h: 20 } },
    { element_index: 3, role: 'AXButton', label: '删除', element_token: 's:3', frame: { x: 0, y: 100, w: 40, h: 20 } },
  ])
  assert.equal(text.match(/Button "删除"/g).length, 2)
})

test('a refused driver effect is reported as a failure, not a success', async () => {
  const { ctx } = harness(() => ({
    results: [{
      result: {
        isError: false,
        value: {
          effect: 'refused',
          refusal: {
            code: 'same_pid_keyboard_ambiguity',
            escalation: { reason: 'multiple same-pid windows match the target' },
          },
        },
      },
    }],
  }))
  await assert.rejects(
    callCuaTool(ctx, {}, 'press_key', { pid: 1, window_id: 2, key: 'a' }),
    /press_key refused \(same_pid_keyboard_ambiguity\): multiple same-pid windows match the target/,
  )
})

test('a structured refusal status is reported as a failure, not a success', async () => {
  const { ctx } = harness(() => ({
    results: [{
      result: {
        isError: false,
        value: { structuredContent: { status: 'refused', message: 'window is not key' } },
      },
    }],
  }))
  await assert.rejects(
    callCuaTool(ctx, {}, 'type_text', { pid: 1, window_id: 2, text: 'x' }),
    /type_text refused \(refused\): window is not key/,
  )
})

test('window capture extracts expanded business state JSON from raw AX elements', async () => {
  const state = { cart: [{ productId: 'SKU-1001', qty: 3 }], orders: [], products: [], lastAction: '加入购物车 SKU-1001 × 3' }
  const { ctx } = harness(() => ({
    results: [{
      result: {
        isError: false,
        value: {
          structuredContent: {
            screenshot_width: 100,
            screenshot_height: 100,
            elements: [{ role: 'AXStaticText', value: JSON.stringify(state) }],
          },
          content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
        },
      },
    }],
  }))
  const observation = await captureWindow(ctx, {}, { pid: 1, window_id: 2 })
  assert.deepEqual(JSON.parse(observation.stateJson), state)
})

test('a focused window remains usable when a browser popup is not ordinary', async () => {
  const { ctx } = harness(() => ({
    results: [{
      result: {
        isError: true,
        content: [{ type: 'text', text: 'bring_to_front: exact window 2 was not verified (request_accepted=true, process_activated=true, focused=true, frontmost_ordinary=false)' }],
      },
    }],
  }))
  const result = await ensureWindowVisible(ctx, {}, { pid: 1, window_id: 2 })
  assert.equal(result.focused, true)
  assert.equal(result.popup, true)
})
