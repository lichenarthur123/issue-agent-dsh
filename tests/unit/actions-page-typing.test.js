import assert from 'node:assert/strict'
import test from 'node:test'
import { operateUi } from '../../packages/desktop-agent/src/actions.js'
import { groundingAttachments, groundingLlm } from './helpers/grounding-llm.js'

const window = { pid: 94262, window_id: 18506 }

const pageTarget = {
  session: 'session-test',
  pid: 94262,
  windowId: 18506,
  targetId: 'bt-real',
  tabId: 'tab-real',
}

const snapshot = {
  refs: [
    { role: 'textbox', name: '收货人', ref: 'p7:3', actions: ['type'] },
    { role: 'textbox', name: '手机号码 *', ref: 'p7:11', actions: ['type'] },
    { role: 'textbox', name: '详细地址', ref: 'p7:15', actions: ['type'] },
    { role: 'button', name: '提交订单', ref: 'p7:21', actions: ['click'] },
  ],
}

function recorder(values = {}, grounderAnswer = "Action: click(point='(231,219)')") {
  const calls = []
  const ctx = {
    llm: groundingLlm(grounderAnswer),
    attachments: groundingAttachments(),
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const name = call.name.replace('mcp__cua-driver-mcp__', '')
        const args = JSON.parse(call.arguments)
        calls.push({ name, args })
        const configured = values[name]
        const value = Array.isArray(configured) ? configured.shift() : configured
        return { results: [{ result: { isError: false, value: value ?? { status: 'ok' } } }] }
      },
    },
  }
  return { calls, ctx }
}

test('typing into a page-bound field replaces the default value in one call', async () => {
  const { calls, ctx } = recorder({
    get_browser_state: [
      { refs: snapshot.refs },
      { refs: snapshot.refs.map(ref => ref.ref === 'p7:11' ? { ...ref, value: '13900000000' } : ref) },
    ],
  })
  const execution = await operateUi(ctx, {}, {}, {
    action: 'type 手机号码', target: '手机号码 *', value: '13900000000',
  }, window, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXTextField', label: '手机号码 *', element_token: 'snap:55', in_web_content: true }],
  }, null, pageTarget)
  assert.deepEqual(calls.map(call => call.name), ['get_browser_state', 'browser_type', 'get_browser_state'])
  assert.deepEqual(calls[0].args, {
    session: 'session-test',
    target_id: 'bt-real',
    tab_id: 'tab-real',
    snapshot_format: 'semantic_v2',
  })
  assert.deepEqual(calls[1].args, {
    session: 'session-test',
    target_id: 'bt-real',
    tab_id: 'tab-real',
    ref: 'p7:11',
    text: '13900000000',
    replace: true,
  })
  assert.deepEqual(execution.calls.map(entry => [entry.tool, entry.status]), [
    ['mcp__cua-driver-mcp__browser_type', 'succeeded'],
  ])
  assert.match(execution.response, /Replaced 手机号码 with 13900000000 via page ref p7:11/)
})

test('a trailing newline submits the page-bound field with a keystroke return', async () => {
  const { calls, ctx } = recorder({ get_browser_state: { refs: snapshot.refs } })
  const execution = await operateUi(ctx, {}, {}, {
    action: 'type 收货人', target: '收货人', value: '张三\n',
  }, window, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXTextField', label: '收货人', element_token: 'snap:51', in_web_content: true }],
  }, null, pageTarget)
  assert.deepEqual(calls.map(call => call.name), ['get_browser_state', 'browser_type', 'get_browser_state', 'browser_type'])
  assert.deepEqual(calls[1].args, {
    session: 'session-test',
    target_id: 'bt-real',
    tab_id: 'tab-real',
    ref: 'p7:3',
    text: '张三',
    replace: true,
  })
  assert.deepEqual(calls[3].args, {
    session: 'session-test',
    target_id: 'bt-real',
    tab_id: 'tab-real',
    ref: 'p7:3',
    text: '\n',
    mode: 'keystrokes',
  })
  assert.match(execution.response, /pressed return/)
})

test('grounded page typing falls back to the native path when no page textbox matches', async t => {
  const { calls, ctx } = recorder({
    get_browser_state: { refs: [{ role: 'button', name: '提交订单', ref: 'p7:21' }] },
    get_window_state: {
      structuredContent: { screenshot_width: 1568, screenshot_height: 1087 },
      content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
    },
  }, "Action: click(start_box='(414,504)')")
  const settings = { grounder: { provider: 'spark-grounder', model: 'ui-tars' } }
  const execution = await operateUi(ctx, {}, settings, {
    action: 'type 搜索', target: '搜索', value: '耳机', locate: 'ground',
  }, window, null, null, pageTarget)
  assert.deepEqual(calls.map(call => call.name), [
    'get_browser_state',
    'get_window_state',
    'click',
    'hotkey',
    'press_key',
    'type_text',
    'get_browser_state',
  ])
  assert.equal(calls.find(call => call.name === 'type_text').args.text, '耳机')
  assert.equal(execution.calls.at(-1).status, 'succeeded')
})

test('page typing bound to another window uses the native path', async () => {
  const { calls, ctx } = recorder()
  await operateUi(ctx, {}, {}, {
    action: 'type 商品名称', target: '商品名称 *', value: '成人纸尿裤',
  }, window, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXTextField', label: '商品名称 *', element_token: 'snap:55', in_web_content: true }],
  }, null, { ...pageTarget, windowId: 999 })
  assert.deepEqual(calls.map(call => call.name), [
    'hotkey',
    'press_key',
    'type_text',
  ])
})

test('a page-bound label with no page textbox match fails instead of typing blind', async () => {
  const { calls, ctx } = recorder({
    get_browser_state: { refs: [{ role: 'button', name: '提交订单', ref: 'p7:21', actions: ['click'] }] },
  })
  const execution = await operateUi(ctx, {}, {}, {
    action: 'type 手机号码', target: '手机号码 *', value: '13900000000',
  }, window, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXTextField', label: '手机号码 *', element_token: 'snap:55', in_web_content: true }],
  }, null, pageTarget)
  assert.deepEqual(calls.map(call => call.name), ['get_browser_state'])
  assert.equal(execution.calls.at(-1).status, 'failed')
  assert.match(execution.response, /no page textbox matches "手机号码 \*"/)
})
test('a page field that already shows the value is left untouched', async () => {
  const { calls, ctx } = recorder({
    get_browser_state: { refs: [{ role: 'textbox', name: '手机号码 *', ref: 'p7:11', value: '13900000000' }] },
  })
  const execution = await operateUi(ctx, {}, {}, {
    action: 'type 手机号码', target: '手机号码 *', value: '13900000000',
  }, window, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXTextField', label: '手机号码 *', element_token: 'snap:55', in_web_content: true }],
  }, null, pageTarget)
  assert.deepEqual(calls.map(call => call.name), ['get_browser_state'])
  assert.match(execution.response, /already shows 13900000000/)
})

test('a matching page value still presses return when the value ends with a newline', async () => {
  const { calls, ctx } = recorder({
    get_browser_state: { refs: [{ role: 'searchbox', name: '搜索商品', ref: 'p7:1', value: '耳机' }] },
  })
  const execution = await operateUi(ctx, {}, {}, {
    action: 'type 搜索', target: '搜索商品', value: '耳机\n',
  }, window, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXTextField', label: '搜索商品', element_token: 'snap:12', in_web_content: true }],
  }, null, pageTarget)
  assert.deepEqual(calls.map(call => call.name), ['get_browser_state', 'browser_type'])
  assert.deepEqual(calls[1].args, {
    session: 'session-test',
    target_id: 'bt-real',
    tab_id: 'tab-real',
    ref: 'p7:1',
    text: '\n',
    mode: 'keystrokes',
  })
  assert.match(execution.response, /already shows 耳机; no typing needed; pressed return/)
})

test('a page snapshot failure is reported instead of a bogus label mismatch', async () => {
  const ctx = {
    tools: {
      execute: async () => ({
        results: [{
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Error: the bound tab was closed' }],
          },
        }],
      }),
    },
  }
  const execution = await operateUi(ctx, {}, {}, {
    action: 'type 手机号码', target: '手机号码 *', value: '13900000000',
  }, window, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXTextField', label: '手机号码 *', element_token: 'snap:55', in_web_content: true }],
  }, null, pageTarget)
  assert.equal(execution.calls.at(-1).status, 'failed')
  assert.match(execution.response, /cannot read the bound page to verify "手机号码 \*": .*bound tab was closed/)
})

test('screenshot typing stays on the native path and verifies the written value', async () => {
  const { calls, ctx } = recorder({
    get_browser_state: { refs: [{ role: 'spinbutton', name: '购买数量', ref: 'p7:8', value: '3' }] },
  })
  const execution = await operateUi(ctx, {}, { observationMode: 'screenshot', groundingMode: 'executor' }, {
    action: 'type 购买数量', target: '购买数量', value: '3', locate: 'ground', point: { x: 100, y: 200 },
  }, window, { ref: { width: 1000, height: 800 } }, null, pageTarget)
  assert.deepEqual(calls.map(call => call.name), ['click', 'hotkey', 'press_key', 'type_text', 'get_browser_state'])
  assert.deepEqual(calls[1].args.keys, ['cmd', 'a'])
  assert.equal(calls.some(call => call.name === 'browser_type'), false)
  assert.match(execution.response, /verified value/)
})

test('a mismatched native readback fails instead of reporting a replacement', async () => {
  const { ctx } = recorder({
    get_browser_state: { refs: [{ role: 'spinbutton', name: '购买数量', ref: 'p7:8', value: '13' }] },
  })
  const execution = await operateUi(ctx, {}, { observationMode: 'screenshot', groundingMode: 'executor' }, {
    action: 'type 购买数量', target: '购买数量', value: '3', locate: 'ground', point: { x: 100, y: 200 },
  }, window, { ref: { width: 1000, height: 800 } }, null, pageTarget)
  assert.equal(execution.calls.at(-1).status, 'failed')
  assert.match(execution.response, /now reads 13 instead of 3/)
})

test('expect.value validates the resulting value instead of the typed input', async () => {
  const { ctx } = recorder({
    get_browser_state: { refs: [{ role: 'spinbutton', name: '购买数量', ref: 'p7:8', value: '10' }] },
  })
  const execution = await operateUi(ctx, {}, { observationMode: 'screenshot', groundingMode: 'executor' }, {
    action: 'type 购买数量', target: '购买数量', value: '15', expect: { value: '10' }, locate: 'ground', point: { x: 100, y: 200 },
  }, window, { ref: { width: 1000, height: 800 } }, null, pageTarget)
  assert.equal(execution.calls.at(-1).status, 'succeeded')
  assert.match(execution.response, /verified value/)
})
