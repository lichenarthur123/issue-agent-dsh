import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clickVariant,
  dragBetween,
  navigateSite,
  operateUi,
  pressChord,
  scrollWindow,
  selectOption,
  waitForScreen,
} from '../../packages/desktop-agent/src/actions.js'
import { DesktopTaskRunner } from '../../packages/desktop-agent/src/task-runner.js'
import { groundUi } from '../../packages/desktop-agent/src/grounder.js'

test('browser navigation uses real window, target, and tab identifiers', async () => {
  const calls = []
  const values = {
    browser_prepare: { prepared_pid: 79854 },
    list_windows: {
      windows: [
        {
          pid: 79854,
          window_id: 17907,
          title: '',
          bounds: { width: 1512, height: 33 },
          is_on_screen: false,
          z_index: 149,
        },
        {
          pid: 79854,
          window_id: 17971,
          title: 'about:blank',
          bounds: { width: 1200, height: 835 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 158,
        },
      ],
    },
    get_browser_state: {
      target_id: 'bt-real',
      tabs: [{ active: true, tab_id: 'tab-real' }],
    },
    browser_navigate: { status: 'ok' },
    bring_to_front: {},
  }
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const name = call.name.replace('mcp__cua-driver-mcp__', '')
        const args = JSON.parse(call.arguments)
        calls.push({ name, args })
        return { results: [{ result: { isError: false, value: values[name] } }] }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  const execution = await navigateSite(ctx, {}, {
    sessionId: 'session-test',
    url: 'http://127.0.0.1:8765/#/home',
    selectWindow: windows => runner.selectContentWindow(windows),
  })
  assert.deepEqual(calls.map(call => call.name), [
    'browser_prepare',
    'list_windows',
    'get_browser_state',
    'browser_navigate',
    'bring_to_front',
  ])
  assert.deepEqual(calls[2].args, { session: 'session-test', pid: 79854, window_id: 17971 })
  assert.deepEqual(calls[3].args, {
    session: 'session-test',
    target_id: 'bt-real',
    tab_id: 'tab-real',
    url: 'http://127.0.0.1:8765/#/home',
  })
  assert.deepEqual(execution.pageTarget, {
    session: 'session-test',
    targetId: 'bt-real',
    tabId: 'tab-real',
    pid: 79854,
    windowId: 17971,
  })
  assert.equal(execution.calls.every(call => call.status === 'succeeded'), true)
})


test('browser navigation passes its own executor identifier guard', async () => {
  const values = {
    browser_prepare: { prepared_pid: 79854 },
    list_windows: {
      windows: [{
        pid: 79854,
        window_id: 17971,
        title: 'about:blank',
        bounds: { width: 1200, height: 835 },
        is_on_screen: true,
        on_current_space: true,
      }],
    },
    get_browser_state: { target_id: 'bt-real', tabs: [{ active: true, tab_id: 'tab-real' }] },
    browser_navigate: { status: 'ok' },
    bring_to_front: {},
  }
  let runner
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const name = call.name.replace('mcp__cua-driver-mcp__', '')
        const args = JSON.parse(call.arguments)
        calls.push(name)
        const denial = runner.validateExecutorCall({ name: call.name, arguments: args })
        if (denial) {
          return { results: [{ result: { isError: true, content: [{ type: 'text', text: `Error: ${denial}` }] } }] }
        }
        return { results: [{ result: { isError: false, value: values[name] } }] }
      },
    },
  }
  runner = new DesktopTaskRunner(ctx, {})
  const execution = await navigateSite(ctx, {}, {
    sessionId: 'session-test',
    url: 'http://127.0.0.1:8765/#/home',
    selectWindow: windows => {
      runner.rememberWindows(windows)
      return runner.selectContentWindow(windows)
    },
  })
  assert.equal(execution.response, 'Navigated to http://127.0.0.1:8765/#/home')
  assert.equal(execution.calls.every(call => call.status === 'succeeded'), true)
  assert.deepEqual(calls, ['browser_prepare', 'list_windows', 'get_browser_state', 'browser_navigate', 'bring_to_front'])
})


test('browser input uses the grounding coordinates without another model rewrite', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const args = JSON.parse(call.arguments)
        calls.push({ name: call.name, args })
        const value = call.name.endsWith('get_window_state')
          ? {
              structuredContent: { screenshot_width: 1568, screenshot_height: 1091 },
              content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
            }
          : {}
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const settings = { grounder: { baseURL: 'http://localhost', model: 'ui-tars' } }
  const execution = await operateUi(ctx, {}, settings, {
    action: 'type', target: '商品名称', value: '成人纸尿裤', locate: 'ground',
  }, { pid: 79854, window_id: 17971 })
  assert.equal(execution.calls.at(-1).status, 'succeeded')
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__get_window_state',
    'mcp__cua-driver-mcp__click',
    'mcp__cua-driver-mcp__press_key',
    'mcp__cua-driver-mcp__press_key',
    'mcp__cua-driver-mcp__type_text',
  ])
  assert.deepEqual(calls[1].args, { pid: 79854, window_id: 17971, x: 231, y: 219, delivery_mode: 'foreground' })
  assert.deepEqual(calls[2].args, { pid: 79854, window_id: 17971, delivery_mode: 'foreground', key: 'a', modifiers: ['cmd'] })
  assert.equal(calls[3].args.key, 'delete')
  assert.deepEqual(calls[4].args, {
    pid: 79854,
    window_id: 17971,
    x: 231,
    y: 219,
    text: '成人纸尿裤',
    delivery_mode: 'foreground',
  })
})


test('a click decision with a value types into the field', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(start_box='(414,504)')" } }],
  }), { status: 200 }))
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const args = JSON.parse(call.arguments)
        calls.push({ name: call.name, args })
        const value = call.name.endsWith('get_window_state')
          ? {
              structuredContent: { screenshot_width: 1568, screenshot_height: 1087 },
              content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
            }
          : {}
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const settings = { grounder: { baseURL: 'http://localhost', model: 'ui-tars' } }
  const execution = await operateUi(ctx, {}, settings, {
    action: 'click', target: '商品名称', value: '30元成人纸尿裤', locate: 'ground',
  }, { pid: 93552, window_id: 18464 })
  assert.equal(execution.calls.at(-1).tool, 'mcp__cua-driver-mcp__type_text')
  assert.equal(execution.calls.at(-1).status, 'succeeded')
  assert.deepEqual(calls.at(-1), {
    name: 'mcp__cua-driver-mcp__type_text',
    args: {
      pid: 93552,
      window_id: 18464,
      x: 414,
      y: 504,
      text: '30元成人纸尿裤',
      delivery_mode: 'foreground',
    },
  })
})


test('an exact accessibility label is clicked by token without the grounding model', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        calls.push({ name: call.name, args: JSON.parse(call.arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  const execution = await operateUi(ctx, {}, {}, {
    action: 'click', target: '确认上架',
  }, { pid: 94262, window_id: 18506 }, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXButton', label: '确认上架', element_token: 'snap:72', in_web_content: true }],
  })
  assert.equal(execution.calls[0].status, 'succeeded')
  assert.deepEqual(calls, [{
    name: 'mcp__cua-driver-mcp__click',
    args: {
      pid: 94262,
      window_id: 18506,
      element_token: 'snap:72',
      snapshot_id: 'snap-1',
      delivery_mode: 'background',
    },
  }])
})


test('text input uses the accessibility token when the field label matches', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        calls.push({ name: call.name, args: JSON.parse(call.arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  const execution = await operateUi(ctx, {}, {}, {
    action: 'type', target: '商品名称 *', value: '成人纸尿裤',
  }, { pid: 94262, window_id: 18506 }, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXTextField', label: '商品名称 *', element_token: 'snap:55', in_web_content: true }],
  })
  assert.equal(execution.calls.at(-1).status, 'succeeded')
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__press_key',
    'mcp__cua-driver-mcp__press_key',
    'mcp__cua-driver-mcp__type_text',
  ])
  assert.deepEqual(calls[0].args, {
    pid: 94262,
    window_id: 18506,
    element_token: 'snap:55',
    snapshot_id: 'snap-1',
    delivery_mode: 'background',
    key: 'a',
    modifiers: ['cmd'],
  })
  assert.equal(calls[1].args.key, 'delete')
  assert.deepEqual(calls[2].args, {
    pid: 94262,
    window_id: 18506,
    element_token: 'snap:55',
    snapshot_id: 'snap-1',
    delivery_mode: 'background',
    text: '成人纸尿裤',
  })
})


test('a unique partial accessibility label still resolves to the element', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        calls.push({ name: call.name, args: JSON.parse(call.arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  const execution = await operateUi(ctx, {}, {}, {
    action: 'click', target: '选择文件',
  }, { pid: 94262, window_id: 18506 }, {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXButton', label: '选择文件: 未选择任何文件', element_token: 'snap:70', in_web_content: true }],
  })
  assert.equal(execution.calls[0].status, 'succeeded')
  assert.equal(calls[0].args.element_token, 'snap:70')

  const ambiguous = await operateUi(ctx, {}, {}, {
    action: 'click', target: '选择',
  }, { pid: 94262, window_id: 18506 }, {
    elements: [
      { role: 'AXButton', label: '选择文件: 未选择任何文件', element_token: 'snap:70', in_web_content: true },
      { role: 'AXButton', label: '选择全部', element_token: 'snap:71', in_web_content: true },
    ],
  })
  assert.equal(ambiguous.calls.some(call => call.status === 'failed'), true)
  assert.match(ambiguous.response, /locate="ground"/)
})


test('typing is skipped when the field already holds the value', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push(batch[0].name)
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  for (const current of ['30', '30.00']) {
    const execution = await operateUi(ctx, {}, {}, {
      action: 'type', target: '售价（元）*', value: '30',
    }, { pid: 94262, window_id: 18506 }, {
      elements: [{ role: 'AXIncrementor', label: '售价（元）*', value: current, element_token: 'snap:44', in_web_content: true }],
    })
    assert.match(execution.response, /already shows 30/)
    assert.equal(execution.calls.length, 0)
  }
  assert.equal(calls.length, 0)
})


test('a missing accessibility label asks the executor to switch to grounding', async () => {
  const ctx = { tools: { execute: async () => ({ results: [] }) } }
  const execution = await operateUi(ctx, {}, {}, {
    action: 'click', target: '不存在的按钮',
  }, { pid: 94262, window_id: 18506 }, { elements: [] })
  assert.equal(execution.calls[0].status, 'failed')
  assert.match(execution.response, /locate="ground"/)
})


function dropdownElements(value) {
  const root = {
    element_index: 0,
    element_token: 'snap:0',
    role: 'AXWindow',
    frame: { x: 0, y: 33, w: 1200, h: 832 },
  }
  const popup = {
    element_index: 41,
    element_token: 'snap:41',
    role: 'AXPopUpButton',
    label: '分类 *',
    value,
    in_web_content: true,
    enabled: true,
    frame: { x: 65, y: 502, w: 361, h: 37 },
  }
  const menu = { element_index: 42, element_token: 'snap:42', role: 'AXMenu', parent_index: 41 }
  const options = ['数码电子', '家居生活', '厨房用品'].map((label, index) => ({
    element_index: 43 + index,
    element_token: `snap:${43 + index}`,
    role: 'AXMenuItem',
    label,
    value: label,
    parent_index: 42,
    in_web_content: true,
    frame: { x: 65, y: 524 + index * 24, w: 361, h: 24 },
  }))
  const duplicate = {
    element_index: 46,
    element_token: 'snap:46',
    role: 'AXMenuItem',
    label: '家居生活',
    value: '家居生活',
    parent_index: 42,
    in_web_content: true,
    frame: { x: 65, y: 572, w: 361, h: 24 },
  }
  const menuBar = { element_index: 90, element_token: 'snap:90', role: 'AXMenuBar' }
  const menuBarItem = { element_index: 91, element_token: 'snap:91', role: 'AXMenuBarItem', label: 'Apple', parent_index: 90 }
  const appleMenu = { element_index: 92, element_token: 'snap:92', role: 'AXMenu', parent_index: 91 }
  const aboutMac = { element_index: 93, element_token: 'snap:93', role: 'AXMenuItem', label: '关于本机', parent_index: 92 }
  return [root, popup, menu, ...options, duplicate, menuBar, menuBarItem, appleMenu, aboutMac]
}

test('a dropdown is driven by accessibility tokens without screenshot coordinates', async () => {
  const calls = []
  let captures = 0
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const name = call.name.replace('mcp__cua-driver-mcp__', '')
        const args = JSON.parse(call.arguments)
        calls.push({ name, args })
        const value = name === 'get_window_state'
          ? {
              structuredContent: {
                screenshot_width: 1568,
                screenshot_height: 1087,
                snapshot_id: `snap-${captures}`,
                elements: dropdownElements(captures === 0 ? '数码电子' : '家居生活'),
              },
              content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
            }
          : {}
        if (name === 'get_window_state') captures += 1
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const window = { pid: 94262, window_id: 18506 }
  const observation = {
    elements: dropdownElements('数码电子'),
    snapshotId: 'snap-initial',
    ref: { width: 1568 },
  }
  const ok = await selectOption(ctx, {}, {}, {
    action: 'select', target: '分类 *', value: '家居生活',
  }, window, observation)
  assert.match(ok.response, /Selected 家居生活 in 分类/)
  const clicks = calls.filter(call => call.name === 'click')
  assert.equal(clicks.length, 2)
  assert.deepEqual(clicks.map(call => call.args.element_token), ['snap:41', 'snap:44'])
  assert.equal(clicks.every(call => call.args.delivery_mode === 'background'), true)
  assert.equal(clicks.every(call => call.args.x === undefined && call.args.y === undefined), true)
  assert.equal(calls.some(call => call.name === 'page'), false)
  assert.equal(calls.some(call => call.name === 'press_key' && call.args.key === 'escape'), true)
  const hovers = calls.filter(call => call.name === 'move_cursor')
  assert.equal(hovers.length, 2)
  assert.deepEqual(hovers.map(call => [call.args.x, call.args.y]), [[321, 637], [321, 689]])
  assert.equal(hovers.every(call => call.args.target?.kind === 'window'), true)

  calls.length = 0
  const missing = await selectOption(ctx, {}, {}, {
    action: 'select', target: '分类 *', value: '母婴用品',
  }, window, observation)
  assert.match(missing.response, /offers 数码电子 \/ 家居生活 \/ 厨房用品 but not 母婴用品/)
  assert.doesNotMatch(missing.response, /关于本机/)
  assert.doesNotMatch(missing.response, /家居生活 \/ 家居生活/)
  assert.match(missing.response, /currently selected: 数码电子/)
  assert.match(missing.response, /with "数码电子" to keep it/)
  assert.equal(missing.calls.some(call => call.status === 'failed'), true)
  assert.equal(missing.calls.filter(call => call.tool === 'mcp__cua-driver-mcp__click').length, 1)
})


test('a dropdown falls back to visual grounding when the menu is not in the AX tree', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(300,350)')" } }],
  }), { status: 200 }))
  const calls = []
  let captures = 0
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const name = call.name.replace('mcp__cua-driver-mcp__', '')
        const args = JSON.parse(call.arguments)
        calls.push({ name, args })
        const collapsed = dropdownElements('数码电子').filter(element => (
          element.role === 'AXWindow' || element.role === 'AXPopUpButton'
        ))
        const value = name === 'zoom'
          ? { width: 500, height: 420, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/jpeg' }] }
          : name === 'get_window_state'
            ? {
                structuredContent: {
                  screenshot_width: 1568,
                  screenshot_height: 1087,
                  snapshot_id: `snap-${captures}`,
                  elements: captures === 0 ? collapsed : dropdownElements('家居生活'),
                },
                content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
              }
            : {}
        if (name === 'get_window_state') captures += 1
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const execution = await selectOption(ctx, {}, { grounder: { baseURL: 'http://grounder', model: 'ui-tars' } }, {
    action: 'select', target: '分类 *', value: '家居生活',
  }, { pid: 94262, window_id: 18506 }, {
    elements: dropdownElements('数码电子'),
    snapshotId: 'snap-initial',
    ref: { width: 1568 },
  })
  assert.match(execution.response, /Selected 家居生活 in 分类 \* via visual grounding/)
  const pixel = calls.find(call => call.name === 'click' && Number.isInteger(call.args.x))
  assert.deepEqual([pixel.args.x, pixel.args.y], [300, 350])
  assert.equal(pixel.args.from_zoom, true)
})


test('browser navigation recovery reuses the existing isolated tab', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push(batch[0])
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  const existing = {
    session: 'session-test', targetId: 'bt-real', tabId: 'tab-real', pid: 79854, windowId: 17971,
  }
  const execution = await navigateSite(ctx, {}, {
    sessionId: 'session-new', url: 'http://127.0.0.1:8765/#/publish', selectWindow: () => null, existing,
  })
  assert.equal(execution.pageTarget, existing)
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__browser_navigate',
    'mcp__cua-driver-mcp__bring_to_front',
  ])
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    session: 'session-test', target_id: 'bt-real', tab_id: 'tab-real', url: 'http://127.0.0.1:8765/#/publish',
  })
})
test('a trailing newline types the text and presses return', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(start_box='(700,1200)')" } }],
  }), { status: 200 }))
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const args = JSON.parse(call.arguments)
        calls.push({ name: call.name, args })
        const value = call.name.endsWith('get_window_state')
          ? {
              structuredContent: { screenshot_width: 992, screenshot_height: 1568 },
              content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
            }
          : {}
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const settings = { grounder: { baseURL: 'http://localhost', model: 'ui-tars' } }
  const execution = await operateUi(ctx, {}, settings, {
    action: 'type', target: '终端窗口输入区域', value: 'open -a Lark\n', locate: 'ground',
  }, { pid: 1067, window_id: 17280 })
  assert.match(execution.response, /pressed return/)
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__get_window_state',
    'mcp__cua-driver-mcp__click',
    'mcp__cua-driver-mcp__press_key',
    'mcp__cua-driver-mcp__press_key',
    'mcp__cua-driver-mcp__type_text',
    'mcp__cua-driver-mcp__press_key',
  ])
  assert.deepEqual(calls[4].args, {
    pid: 1067,
    window_id: 17280,
    x: 700,
    y: 1200,
    text: 'open -a Lark',
    delivery_mode: 'foreground',
  })
  assert.deepEqual(calls[5].args, {
    pid: 1067,
    window_id: 17280,
    delivery_mode: 'foreground',
    key: 'return',
  })
})

test('a key chord uses hotkey and a single key uses press_key', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push({ name: batch[0].name, args: JSON.parse(batch[0].arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  const window = { pid: 1067, window_id: 17280 }
  const chord = await pressChord(ctx, {}, { value: 'cmd+s' }, window, {})
  assert.match(chord.response, /Pressed cmd\+s/)
  const single = await pressChord(ctx, {}, { value: 'enter' }, window, {})
  assert.match(single.response, /Pressed return/)
  assert.deepEqual(calls.map(call => call.name), ['mcp__cua-driver-mcp__hotkey', 'mcp__cua-driver-mcp__press_key'])
  assert.deepEqual(calls[0].args, {
    pid: 1067,
    window_id: 17280,
    delivery_mode: 'background',
    keys: ['cmd', 's'],
  })
  assert.deepEqual(calls[1].args, {
    pid: 1067,
    window_id: 17280,
    delivery_mode: 'background',
    key: 'return',
  })
})

test('scroll targets the matching AX area and falls back to the focused region', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push({ name: batch[0].name, args: JSON.parse(batch[0].arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  const window = { pid: 85726, window_id: 8228 }
  const observation = {
    snapshotId: 'snap-1',
    elements: [{ role: 'AXScrollArea', label: '任务明细', element_token: 'snap:9', in_web_content: true }],
  }
  const targeted = await scrollWindow(ctx, {}, { target: '任务明细', direction: 'down', amount: 3, by: 'line' }, window, observation)
  assert.match(targeted.response, /Scrolled down 3 line in 任务明细/)
  assert.deepEqual(calls[0].args, {
    pid: 85726,
    window_id: 8228,
    element_token: 'snap:9',
    snapshot_id: 'snap-1',
    direction: 'down',
    amount: 3,
    by: 'line',
    delivery_mode: 'foreground',
  })
  const fallback = await scrollWindow(ctx, {}, { target: '不存在的区域', direction: 'up', amount: 2, by: 'page' }, window, observation)
  assert.match(fallback.response, /no AX match/)
  assert.equal(calls[1].args.element_token, undefined)
  assert.equal(calls[1].args.by, 'page')
})

test('a grounded double-click escalates to foreground delivery', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(start_box='(420,300)')" } }],
  }), { status: 200 }))
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const name = batch[0].name
        calls.push({ name, args: JSON.parse(batch[0].arguments) })
        const value = name.endsWith('get_window_state')
          ? {
              structuredContent: { screenshot_width: 1568, screenshot_height: 1087 },
              content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
            }
          : {}
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const settings = { grounder: { baseURL: 'http://localhost', model: 'ui-tars' } }
  const execution = await clickVariant(ctx, {}, settings, {
    target: '文件', locate: 'ground',
  }, { pid: 93552, window_id: 18464 }, {}, undefined, { tool: 'double_click', verb: 'Double-clicked' })
  assert.match(execution.response, /Double-clicked 文件/)
  assert.deepEqual(calls.at(-1), {
    name: 'mcp__cua-driver-mcp__double_click',
    args: {
      pid: 93552,
      window_id: 18464,
      x: 420,
      y: 300,
      delivery_mode: 'foreground',
    },
  })
})

test('drag resolves both labels to window-local points', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push({ name: batch[0].name, args: JSON.parse(batch[0].arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  const observation = {
    snapshotId: 'snap-1',
    ref: { width: 1000 },
    elements: [
      { role: 'AXWindow', frame: { x: 10, y: 10, w: 500, h: 400 } },
      { role: 'AXSlider', label: '音量', element_token: 'snap:1', frame: { x: 60, y: 110, w: 100, h: 20 } },
      { role: 'AXStaticText', label: '最右端', element_token: 'snap:2', frame: { x: 460, y: 110, w: 40, h: 20 } },
    ],
  }
  const execution = await dragBetween(ctx, {}, {}, {
    target: '音量', value: '最右端', locate: 'ax',
  }, { pid: 94262, window_id: 18506 }, observation, undefined)
  assert.match(execution.response, /Dragged 音量 to 最右端/)
  assert.deepEqual(calls, [{
    name: 'mcp__cua-driver-mcp__drag',
    args: {
      pid: 94262,
      window_id: 18506,
      from_x: 200,
      from_y: 220,
      to_x: 940,
      to_y: 220,
      duration_ms: 500,
      delivery_mode: 'foreground',
    },
  }])
})

test('wait pauses without calling a desktop tool', async () => {
  const startedAt = Date.now()
  const execution = await waitForScreen({ seconds: 1, target: '任务列表' })
  assert.match(execution.response, /Waited 1s for 任务列表/)
  assert.deepEqual(execution.calls, [])
  assert.ok(Date.now() - startedAt >= 1000)
})
test('the runner routes scroll and key decisions after bringing the window forward', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push({ name: batch[0].name, args: JSON.parse(batch[0].arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  const observation = {
    pid: 85726,
    window_id: 8228,
    snapshotId: 'snap-1',
    elements: [{ role: 'AXScrollArea', label: '任务明细', element_token: 'snap:9' }],
  }
  const scrolled = await runner.executeDecision({}, {
    kind: 'scroll', target: '任务明细', direction: 'down', amount: 3, by: 'line',
  }, observation)
  assert.match(scrolled.response, /Scrolled down 3 line in 任务明细/)
  const pressed = await runner.executeDecision({}, { kind: 'key', value: 'cmd+s' }, observation)
  assert.match(pressed.response, /Pressed cmd\+s/)
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__bring_to_front',
    'mcp__cua-driver-mcp__scroll',
    'mcp__cua-driver-mcp__bring_to_front',
    'mcp__cua-driver-mcp__hotkey',
  ])
  assert.deepEqual(calls[3].args, {
    pid: 85726,
    window_id: 8228,
    delivery_mode: 'background',
    keys: ['cmd', 's'],
  })
})

test('a step fails instead of acting on a window that cannot be shown', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push({ name: batch[0].name, args: JSON.parse(batch[0].arguments) })
        return { results: [{ result: { isError: false, value: { activated: false } } }] }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  const execution = await runner.executeDecision({}, {
    kind: 'action', target: '保存', locate: 'ax',
  }, { pid: 85726, window_id: 8228, elements: [] })
  assert.equal(execution.calls[0].tool, 'mcp__cua-driver-mcp__bring_to_front')
  assert.equal(execution.calls[0].status, 'failed')
  assert.match(execution.response, /could not be brought to the front/)
  assert.ok(!calls.some(call => call.name === 'mcp__cua-driver-mcp__click'))
})

test('screenshot mode forces grounded actions and leaves other kinds alone', () => {
  const screenshot = new DesktopTaskRunner({}, { observationMode: 'screenshot' })
  const hybrid = new DesktopTaskRunner({}, { observationMode: 'hybrid' })
  const action = { kind: 'action', target: '保存', locate: 'ax' }
  assert.equal(screenshot.applyObservationMode(action).locate, 'ground')
  assert.equal(hybrid.applyObservationMode(action).locate, 'ax')
  assert.equal(screenshot.applyObservationMode({ kind: 'double_click', locate: 'ax' }).locate, 'ground')
  assert.equal(screenshot.applyObservationMode({ kind: 'select', locate: 'ax' }).locate, 'ax')
  assert.equal(screenshot.applyObservationMode({ kind: 'launch', locate: 'ax' }).locate, 'ax')
  assert.equal(screenshot.applyObservationMode({ kind: 'key', locate: 'ax' }).locate, 'ax')
  assert.equal(new DesktopTaskRunner({}, {}).applyObservationMode(action).locate, 'ax')
})

test('an option click zooms into the dropdown and constrains the grounding instruction', async t => {
  let requestBody = null
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requestBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Action: click(point='(120,240)')" } }],
    }), { status: 200 })
  })
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const name = batch[0].name
        calls.push({ name, args: JSON.parse(batch[0].arguments) })
        const value = name.endsWith('zoom')
          ? { width: 500, height: 420, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/jpeg' }] }
          : { structuredContent: { screenshot_width: 1568, screenshot_height: 980 }, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }] }
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const settings = {
    grounder: { baseURL: 'http://localhost', model: 'ui-tars' },
    grounding: { lastPoint: { x: 940, y: 657, width: 1568, height: 980 } },
  }
  await operateUi(ctx, {}, settings, {
    action: "Click the '重要紧急' option in the task label dropdown",
    target: '重要紧急',
    locate: 'ground',
  }, { pid: 85726, window_id: 8228 }, {})
  const zoom = calls.find(call => call.name.endsWith('zoom'))
  assert.deepEqual(zoom.args, { pid: 85726, window_id: 8228, x1: 580, y1: 460, x2: 1300, y2: 980 })
  assert.equal(calls.at(-1).args.from_zoom, true)
  const prompt = requestBody.messages[0].content[0].text
  assert.match(prompt, /task label dropdown/)
  assert.match(prompt, /never click identical text elsewhere/)
})

test('a plain grounded click uses the full screenshot and records the anchor', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(420,300)')" } }],
  }), { status: 200 }))
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const name = batch[0].name
        calls.push({ name, args: JSON.parse(batch[0].arguments) })
        const value = name.endsWith('get_window_state')
          ? { structuredContent: { screenshot_width: 1568, screenshot_height: 980 }, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }] }
          : {}
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const settings = { grounder: { baseURL: 'http://localhost', model: 'ui-tars' }, grounding: {} }
  await operateUi(ctx, {}, settings, { action: 'click 保存', target: '保存', locate: 'ground' }, { pid: 1, window_id: 2 }, {})
  assert.ok(!calls.some(call => call.name.endsWith('zoom')))
  assert.equal(calls.at(-1).args.from_zoom, undefined)
  assert.deepEqual(settings.grounding.lastPoint, { x: 420, y: 300, width: 1568, height: 980 })
})

test('zoom dimensions are read from structuredContent', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(120,240)')" } }],
  }), { status: 200 }))
  const ctx = {
    tools: {
      execute: async () => ({
        results: [{
          result: {
            isError: false,
            value: {
              structuredContent: { width: 500, height: 361 },
              content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/jpeg' }],
            },
          },
        }],
      }),
    },
  }
  const point = await groundUi(ctx, {}, { grounder: { baseURL: 'http://localhost', model: 'ui-tars' }, grounding: {} }, {
    pid: 1, window_id: 2, instruction: 'click: 重要紧急', anchor: { x: 940, y: 657, width: 1568, height: 980 },
  })
  assert.equal(point.fromZoom, true)
  assert.deepEqual([point.x, point.y], [120, 240])
})

test('a zoom without dimensions falls back to the full screenshot', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(120,240)')" } }],
  }), { status: 200 }))
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const name = batch[0].name
        calls.push(name)
        const value = name.endsWith('get_window_state')
          ? { structuredContent: { screenshot_width: 1568, screenshot_height: 980 }, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }] }
          : { content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/jpeg' }] }
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const point = await groundUi(ctx, {}, { grounder: { baseURL: 'http://localhost', model: 'ui-tars' }, grounding: {} }, {
    pid: 1, window_id: 2, instruction: 'click: 重要紧急', anchor: { x: 940, y: 657, width: 1568, height: 980 },
  })
  assert.equal(point.fromZoom, undefined)
  assert.deepEqual(calls, ['mcp__cua-driver-mcp__zoom', 'mcp__cua-driver-mcp__get_window_state'])
})

test('an executor supplied point bypasses the grounder entirely', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('grounder must not be called') })
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push({ name: batch[0].name, args: JSON.parse(batch[0].arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  await operateUi(ctx, {}, { groundingMode: 'executor', grounder: { baseURL: 'http://localhost', model: 'ui-tars' } }, {
    action: 'click 重要紧急', target: '重要紧急', locate: 'ground', point: { x: 940, y: 657 },
  }, { pid: 85726, window_id: 8228 }, {})
  assert.deepEqual(calls.map(call => call.name), ['mcp__cua-driver-mcp__click'])
  assert.deepEqual(calls[0].args, { pid: 85726, window_id: 8228, x: 940, y: 657, delivery_mode: 'foreground' })
})

test('an out-of-range zoom point retries with the full screenshot', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(start_box='(518,208)')" } }],
  }), { status: 200 }))
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const name = batch[0].name
        calls.push(name)
        const value = name.endsWith('get_window_state')
          ? { structuredContent: { screenshot_width: 1568, screenshot_height: 980 }, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }] }
          : { structuredContent: { width: 500, height: 361 }, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/jpeg' }] }
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const point = await groundUi(ctx, {}, { grounder: { baseURL: 'http://localhost', model: 'ui-tars' }, grounding: {} }, {
    pid: 1, window_id: 2, instruction: 'click: 重要紧急', anchor: { x: 940, y: 657, width: 1568, height: 980 },
  })
  assert.equal(point.fromZoom, undefined)
  assert.deepEqual([point.x, point.y], [518, 208])
  assert.deepEqual(calls, ['mcp__cua-driver-mcp__zoom', 'mcp__cua-driver-mcp__get_window_state'])
})

test('a reference point is forwarded to the grounder and refined', async t => {
  let requestBody = null
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requestBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Action: click(point='(951,660)')" } }],
    }), { status: 200 })
  })
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push({ name: batch[0].name, args: JSON.parse(batch[0].arguments) })
        const value = {
          structuredContent: { screenshot_width: 1568, screenshot_height: 980 },
          content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
        }
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  await operateUi(ctx, {}, { groundingMode: 'auto', grounder: { baseURL: 'http://localhost', model: 'ui-tars' } }, {
    action: 'click 重要紧急', target: '重要紧急', locate: 'ground', point: { x: 940, y: 657 },
  }, { pid: 85726, window_id: 8228 }, {})
  assert.match(requestBody.messages[0].content[0].text, /reference_point: \(940,657\)/)
  assert.deepEqual(calls.map(call => call.name), ['mcp__cua-driver-mcp__get_window_state', 'mcp__cua-driver-mcp__click'])
  assert.deepEqual([calls.at(-1).args.x, calls.at(-1).args.y], [951, 660])
  assert.ok(!calls.some(call => call.name.endsWith('zoom')))
})

test('a grounder point far from the reference retries with a zoom crop', async t => {
  const answers = ["Action: click(point='(100,100)')", "Action: click(point='(120,240)')"]
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: answers.shift() } }],
  }), { status: 200 }))
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const name = batch[0].name
        calls.push(name)
        const value = name.endsWith('zoom')
          ? { structuredContent: { width: 500, height: 361 }, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/jpeg' }] }
          : { structuredContent: { screenshot_width: 1568, screenshot_height: 980 }, content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }] }
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const point = await groundUi(ctx, {}, { grounder: { baseURL: 'http://localhost', model: 'ui-tars' }, grounding: {} }, {
    pid: 1, window_id: 2, instruction: 'click: 重要紧急', reference: { x: 940, y: 657 },
  })
  assert.equal(point.fromZoom, true)
  assert.deepEqual([point.x, point.y], [120, 240])
  assert.deepEqual(calls, ['mcp__cua-driver-mcp__get_window_state', 'mcp__cua-driver-mcp__zoom'])
})

test('normalized_1000 points are converted to screenshot pixels before clicking', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('grounder must not be called') })
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push({ name: batch[0].name, args: JSON.parse(batch[0].arguments) })
        return { results: [{ result: { isError: false, value: {} } }] }
      },
    },
  }
  await operateUi(ctx, {}, {
    groundingMode: 'executor',
    executorCoordinateSpace: 'normalized_1000',
    grounder: { baseURL: 'http://localhost', model: 'ui-tars' },
  }, {
    action: 'click 重要紧急', target: '重要紧急', locate: 'ground', point: { x: 500, y: 500 },
  }, { pid: 85726, window_id: 8228 }, { ref: { width: 1568, height: 980 } })
  assert.deepEqual(calls[0].args, { pid: 85726, window_id: 8228, x: 784, y: 490, delivery_mode: 'foreground' })
})
