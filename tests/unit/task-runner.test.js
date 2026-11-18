import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { PRESERVE_WINDOWS_ON_FAILURE } from '../../packages/desktop-agent/src/cleanup.js'
import { DesktopTaskRunner } from '../../packages/desktop-agent/src/task-runner.js'

const PLAN = '1. 打开 http://127.0.0.1:8765/#/home\n2. 进入 SKU 上架表单\n3. 填写商品名称 成人纸尿裤\n4. 点击确认上架'

function browserValues() {
  return {
    browser_prepare: { prepared_pid: 79854 },
    list_apps: {
      apps: [
        { name: 'Safari', bundle_id: 'com.apple.Safari', running: true },
        { name: 'Lark', bundle_id: 'com.electron.lark', running: false },
      ],
    },
    launch_app: {
      pid: 74267,
      bundle_id: 'com.apple.Safari',
      launch_state: { requested: true, process_running: true, window_ready: true },
    },
    list_windows: {
      windows: [{
        pid: 79854,
        window_id: 17971,
        title: 'AmaShop',
        bounds: { width: 1200, height: 835 },
        is_on_screen: true,
        on_current_space: true,
        z_index: 158,
      }],
    },
    get_browser_state: { target_id: 'bt-real', tabs: [{ active: true, tab_id: 'tab-real' }] },
    browser_navigate: { status: 'ok' },
    bring_to_front: {},
    end_session: {},
  }
}

function harness(t, { decisions, verifications = [], maxSteps = 6, keepWindowsOnFailure = false, values = browserValues(), failTools = [], failToolMessages = {}, thinkingMode = 'adaptive', plannerEnabled = true }) {
  const artifactRoot = mkdtempSync(join('artifacts', 'task-runner-test-'))
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }))
  const calls = []
  const plannerRequests = []
  const executorRequests = []
  const modelCalls = []
  const llmModes = []
  const agent = {
    status: 'idle',
    session: { seq: 0 },
    whenIdle: async () => {},
    ctx: { on: () => () => {} },
  }
  const ctx = {
    get: () => undefined,
    agents: {
      create: async options => {
        options.setup({
          on: () => () => {},
          tools: { guard: () => () => {} },
        })
        return {
          agent,
          dispose: async () => {
            mkdirSync(join(artifactRoot, options.sessionId), { recursive: true })
            writeFileSync(join(artifactRoot, options.sessionId, 'result.json'), JSON.stringify({
              status: 'cancelled', answer: 'unused', desktopToolCalls: calls.length,
            }))
          },
        }
      },
    },
    sessions: { flush: async () => {} },
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const name = call.name.replace('mcp__cua-driver-mcp__', '')
        const args = JSON.parse(call.arguments)
        calls.push({ name, args })
        if (failTools.includes(name)) {
          return { results: [{ result: { isError: true, content: [{ type: 'text', text: failToolMessages[name] ?? `${name} failed` }] } }] }
        }
        const windowState = name === 'get_window_state' && Array.isArray(values.get_window_state)
          ? values.get_window_state.shift()
          : values.get_window_state
        const value = name === 'get_window_state'
          ? {
              structuredContent: {
                screenshot_width: 1568,
                screenshot_height: 1091,
                pid: args.pid,
                window_id: args.window_id,
                ...windowState?.structuredContent,
              },
              content: [{ type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' }],
            }
          : values[name] ?? {}
        return { results: [{ result: { isError: false, value } }] }
      },
    },
    attachments: { saveImage: async () => ({ attachmentId: 'image' }) },
    llm: {
      stream: async function* (options) {
        modelCalls.push(options.maxTokens)
        llmModes.push(options.reasoningEffort ?? null)
        if (options.maxTokens === 1200) {
          plannerRequests.push(options.messages)
          yield { type: 'text-delta', text: JSON.stringify({ plan: PLAN }) }
          yield { type: 'finish', reason: { kind: 'completed' } }
          return
        }
        if (options.maxTokens === 6000) {
          executorRequests.push(options.messages)
          const value = decisions.shift()
          if (!value) throw new Error('executor decisions exhausted')
          yield { type: 'text-delta', text: JSON.stringify(value) }
          yield { type: 'finish', reason: { kind: 'completed' } }
          return
        }
        const value = verifications.shift() ?? { status: 'passed', reason: '目标任务已完成' }
        yield { type: 'text-delta', text: JSON.stringify(value) }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  const settings = {
    artifactRoot,
    cwd: process.cwd(),
    taskTimeoutMs: 10000,
    maxSteps,
    keepWindowsOnFailure,
    planner: { provider: 'planner', model: 'small' },
    plannerEnabled,
    browserProfile: { mode: 'isolated_new' },
    executor: { provider: 'executor', model: 'vl' },
    grounder: { baseURL: 'http://grounder', model: 'ui-tars' },
    thinkingMode,
  }
  const runner = new DesktopTaskRunner(ctx, settings)
  let observationCount = 0
  runner.observe = async () => {
    observationCount += 1
    return {
      data: new Uint8Array([1]),
      text: `AX state ${observationCount}`,
      ref: { mediaType: 'image/png', width: 1568, height: 1091 },
      pid: 79854,
      window_id: 17971,
    }
  }
  return {
    runner,
    agent,
    calls,
    plannerRequests,
    executorRequests,
    modelCalls,
    llmModes,
    run: () => runner.run({
      key: 'acme/desktop#1',
      issue: { title: '上架商品', body: '打开amashop网站，上架一个30块钱的成人纸尿裤' },
    }),
  }
}

function userText(messages) {
  return messages[1].content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function userImages(messages) {
  return messages[1].content.filter(block => block.type === 'image')
}

test('the planner expands once and the executor owns a compact loop', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const h = harness(t, {
    decisions: [
      {
        done: false,
        kind: 'navigate',
        action: '打开 AmaShop',
        url: 'http://127.0.0.1:8765/#/home',
      },
      {
        done: false,
        kind: 'action',
        action: 'type',
        target: '商品名称',
        value: '成人纸尿裤',
        locate: 'ground',
      },
      { done: true, response: '已上架成人纸尿裤，售价 30 元' },
    ],
    verifications: [
      { status: 'passed', reason: '首页已加载' },
      { status: 'passed', reason: '名称已填写' },
      { status: 'passed', reason: '商品已上架' },
    ],
  })
  const result = await h.run()

  assert.equal(h.plannerRequests.length, 1)
  assert.equal(h.executorRequests.length, 3)
  assert.deepEqual(h.modelCalls, [1200, 6000, 6000, 6000, 800])
  for (const request of h.executorRequests) {
    assert.equal(userImages(request).length, 1)
  }

  const second = userText(h.executorRequests[1])
  assert.match(second, /<execution-plan>\n1\. 打开 http:\/\/127\.0\.0\.1:8765\/#\/home/)
  assert.match(second, /"step":1/)
  assert.match(second, /AX state 2/)
  assert.doesNotMatch(second, /AX state 1/)

  const third = userText(h.executorRequests[2])
  assert.match(third, /"step":2/)
  assert.match(third, /"value":"成人纸尿裤"/)
  assert.match(third, /AX state 3/)
  assert.doesNotMatch(third, /AX state 2/)

  assert.equal(result.status, 'succeeded')
  assert.equal(result.answer, '已上架成人纸尿裤，售价 30 元')
  assert.equal(result.steps.length, 2)
  assert.equal(result.steps[0].execution.status, 'succeeded')
  assert.equal(result.steps[1].execution.status, 'succeeded')
  assert.match(result.plan, /1\. 打开 http:\/\/127\.0\.0\.1:8765\/#\/home/)
  assert.match(result.plan, /Executed:/)
  assert.equal(h.calls.some(call => call.name === 'end_session' && call.args.session === result.sessionId), true)
  assert.equal(h.agent[PRESERVE_WINDOWS_ON_FAILURE], false)
})

test('existing profile navigation preserves the local browser session', async t => {
  const values = {
    ...browserValues(),
    list_windows: {
      windows: [{
        app_name: 'Google Chrome',
        pid: 79854,
        window_id: 17971,
        title: 'AmaShop',
        bounds: { width: 1200, height: 835 },
        is_on_screen: true,
        on_current_space: true,
      }],
    },
  }
  const h = harness(t, {
    values,
    decisions: [
      { done: false, kind: 'navigate', action: '打开 AmaShop', url: 'http://127.0.0.1:8765/#/home' },
      { done: true, response: '已使用本机登录态打开网站' },
    ],
    verifications: [{ status: 'passed', reason: '完成' }],
  })
  h.runner.settings.browserProfile = { mode: 'existing_profile' }
  const result = await h.run()
  assert.equal(result.status, 'succeeded')
  const prepare = h.calls.find(call => call.name === 'browser_prepare')
  assert.deepEqual(prepare.args, {
    session: result.sessionId,
    pid: 79854,
    window_id: 17971,
    strategy: { kind: 'existing_profile' },
  })
  assert.equal(h.calls.some(call => call.name === 'end_session'), false)
})

test('browser consent failures stop immediately without model retries', async t => {
  const values = {
    ...browserValues(),
    list_windows: {
      windows: [{
        app_name: 'Google Chrome',
        pid: 79854,
        window_id: 17971,
        title: 'AmaShop',
        bounds: { width: 1200, height: 835 },
        is_on_screen: true,
        on_current_space: true,
      }],
    },
  }
  const h = harness(t, {
    values,
    failTools: ['browser_prepare'],
    failToolMessages: { browser_prepare: 'browser_consent_required: existing-profile grant is missing' },
    decisions: [
      { done: false, kind: 'navigate', action: '打开 AmaShop', url: 'http://127.0.0.1:8765/#/home' },
      { done: true, response: '不应执行到这里' },
    ],
  })
  h.runner.settings.browserProfile = { mode: 'existing_profile' }
  const result = await h.run()
  assert.equal(result.status, 'failed')
  assert.equal(h.executorRequests.length, 1)
  assert.match(result.error.message, /browser_consent_required/)
})

test('planner can be disabled so the original task goes directly to the executor', async t => {
  const h = harness(t, {
    plannerEnabled: false,
    decisions: [
      { done: false, kind: 'key', value: 'return' },
      { done: true, response: '已直接执行原始任务' },
    ],
    verifications: [{ status: 'passed', reason: '完成' }],
  })
  const result = await h.run()
  assert.equal(h.plannerRequests.length, 0)
  assert.deepEqual(h.modelCalls, [6000, 6000, 800])
  assert.match(h.executorRequests[0][0].content[0].text, /No planner expands the task/)
  assert.ok(!userText(h.executorRequests[0]).includes('<execution-plan>'))
  assert.match(userText(h.executorRequests[0]), /<original-task>[\s\S]*上架商品/)
  assert.match(result.plan, /Planner disabled; executed directly from the original task/)
})

test('completion feedback reaches the executor and requires whole-task verification', async t => {
  const h = harness(t, {
    decisions: [
      { done: false, kind: 'launch', action: '启动 Safari', target: 'com.apple.Safari', needsVerify: false },
      { done: true, response: '' },
      { done: true, response: '已完成' },
      { done: true, response: '已完成' },
    ],
    verifications: [
      { status: 'failed', reason: '商品尚未上架' },
      { status: 'passed', reason: '商品已上架' },
    ],
  })
  h.runner.observe = async () => ({
    data: new Uint8Array([1]),
    text: '当前浏览器仍显示网站主页，商品尚未上架',
    ref: { mediaType: 'image/png', width: 800, height: 600 },
    pid: 74267,
    window_id: 17971,
  })
  const result = await h.run()

  assert.equal(h.executorRequests.length, 4)
  assert.match(userText(h.executorRequests[2]), /done requires a non-empty final response/)
  assert.match(userText(h.executorRequests[3]), /商品尚未上架/)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.answer, '已完成')
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0].execution.status, 'succeeded')
})

test('an exhausted executor loop preserves the desktop for debugging', async t => {
  const h = harness(t, {
    decisions: [
      { done: true, response: '' },
      { done: true, response: '' },
    ],
    maxSteps: 2,
    keepWindowsOnFailure: true,
  })
  const result = await h.run()
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'STEP_BUDGET_EXCEEDED')
  assert.equal(h.agent[PRESERVE_WINDOWS_ON_FAILURE], true)
})

test('failed browser execution skips verification and reports the blocker', async t => {
  const h = harness(t, {
    decisions: [
      {
        done: false,
        kind: 'navigate',
        action: '打开 AmaShop',
        url: 'http://127.0.0.1:8765/#/home',
      },
      { done: true, blocked: true, response: '浏览器准备被拒绝' },
    ],
    failTools: ['browser_prepare'],
  })
  const result = await h.run()
  assert.equal(result.steps[0].execution.status, 'failed')
  assert.equal(result.steps[0].verification, undefined)
  assert.equal(result.answer, '浏览器准备被拒绝')
  assert.equal(result.status, 'unverified')
  assert.deepEqual(h.modelCalls, [1200, 6000, 6000])
})

test('an invalid decision is retried with feedback instead of failing the task', async t => {
  const h = harness(t, {
    decisions: [
      { invalid: true },
      {
        done: false,
        kind: 'navigate',
        action: '打开 AmaShop',
        url: 'http://127.0.0.1:8765/#/home',
      },
      { done: true, response: '已上架' },
    ],
  })
  const result = await h.run()
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.length, 1)
  assert.match(userText(h.executorRequests[1]), /invalid decision: decision.action is required/)
  assert.match(userText(h.executorRequests[2]), /"step":1/)
  assert.match(userText(h.executorRequests[2]), /<feedback-history>.*invalid decision: decision\.action is required/)
})

test('a dropdown decision is executed with accessibility tokens', async t => {
  const popup = {
    element_index: 41,
    element_token: 'snap:41',
    role: 'AXPopUpButton',
    label: '分类 *',
    value: '数码电子',
    in_web_content: true,
  }
  const menu = { element_index: 42, element_token: 'snap:42', role: 'AXMenu', parent_index: 41 }
  const options = ['数码电子', '家居生活'].map((label, index) => ({
    element_index: 43 + index,
    element_token: `snap:${43 + index}`,
    role: 'AXMenuItem',
    label,
    value: label,
    parent_index: 42,
    in_web_content: true,
  }))
  const h = harness(t, {
    decisions: [
      { done: false, kind: 'select', target: '分类 *', value: '家居生活', needsVerify: false },
      { done: true, response: '已选择分类' },
    ],
    values: {
      ...browserValues(),
      get_window_state: [
        { structuredContent: { snapshot_id: 'snap-expanded', elements: [popup, menu, ...options] } },
        { structuredContent: { snapshot_id: 'snap-after', elements: [{ ...popup, value: '家居生活' }] } },
      ],
    },
  })
  h.runner.observe = async () => ({
    data: new Uint8Array([1]),
    text: 'AX form',
    ref: { mediaType: 'image/png', width: 1568, height: 1091 },
    pid: 79854,
    window_id: 17971,
    elements: [popup],
    snapshotId: 'snap-initial',
  })
  const result = await h.run()
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps[0].execution.status, 'succeeded')
  assert.equal(h.calls.some(call => call.name === 'page'), false)
  const clicks = h.calls.filter(call => call.name === 'click')
  assert.deepEqual(clicks.map(call => call.args.element_token), ['snap:41', 'snap:44'])
  assert.equal(clicks.every(call => call.args.delivery_mode === 'background'), true)
  assert.equal(h.calls.some(call => call.name === 'bring_to_front'), true)
})

test('a launched app becomes the observed foreground window', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const args = JSON.parse(call.arguments)
        calls.push({ name: call.name, args })
        const value = call.name.endsWith('list_windows')
          ? { structuredContent: { windows: [{ pid: 74267, window_id: 17280, z_index: 4 }] } }
          : {}
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  runner.targetWindow = { pid: 1067, window_id: 99 }
  const execution = {
    calls: [{
      tool: 'mcp__cua-driver-mcp__launch_app',
      status: 'succeeded',
      output: 'Launched Safari (pid 74267) in background.',
    }],
  }
  await runner.activateLaunchedApp({}, execution)
  assert.deepEqual(runner.targetWindow, { pid: 74267, window_id: 17280 })
  assert.deepEqual(execution.activation, { status: 'succeeded', pid: 74267, window_id: 17280 })
  assert.deepEqual(calls.map(call => call.name), [
    'mcp__cua-driver-mcp__list_windows',
    'mcp__cua-driver-mcp__bring_to_front',
  ])
  assert.deepEqual(calls[0].args, { pid: 74267, on_screen_only: false })
  assert.deepEqual(calls[1].args, { pid: 74267, window_id: 17280 })
})

test('executor rejects invented window identifiers before calling CUA', () => {
  const runner = new DesktopTaskRunner({}, {})
  runner.rememberWindows([{ pid: 1067, window_id: 17280 }])
  assert.match(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__browser_prepare',
    arguments: { pid: 12345, window_id: 67890 },
  }), /unknown pid 12345/)
  assert.equal(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__browser_prepare',
    arguments: {},
  }), undefined)
  assert.equal(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__browser_prepare',
    arguments: { pid: 1067, window_id: 17280 },
  }), undefined)
  assert.equal(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__list_windows',
    arguments: { pid: 99999 },
  }), undefined)
})

test('browser page interactions use accessibility tokens or grounded coordinates', () => {
  const runner = new DesktopTaskRunner({}, {})
  runner.rememberWindows([{ pid: 1067, window_id: 17280 }])
  runner.pageTarget = { session: 'amashop', pid: 1067, windowId: 17280 }
  assert.match(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__browser_click',
    arguments: { ref: 'p1:38' },
  }), /desktop_ground_ui followed by native click or type_text with x,y/)
  assert.match(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__click',
    arguments: { pid: 1067, window_id: 17280, element_index: 26 },
  }), /requires an element_token from the current snapshot/)
  assert.equal(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__click',
    arguments: { pid: 1067, window_id: 17280, x: 400, y: 300, delivery_mode: 'background' },
  }), undefined)
  assert.equal(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__click',
    arguments: { pid: 1067, window_id: 17280, element_token: 'snap:41', snapshot_id: 'snap', delivery_mode: 'background' },
  }), undefined)
})

test('observation never targets the Cua Driver authorization window', async () => {
  const ctx = {
    tools: {
      execute: async ({ calls }) => {
        const name = calls[0].name
        const value = name.endsWith('get_accessibility_tree')
          ? {
              apps: [{ pid: 78559, bundle_id: 'com.trycua.driver' }],
              windows: [
                { app_name: 'Cua Driver', pid: 78559, title: 'Authorize', window_id: 10890 },
                { app_name: '终端', pid: 1067, title: 'gamma2', window_id: 17280 },
              ],
            }
          : {
              structuredContent: { screenshot_width: 1, screenshot_height: 1 },
              content: [
                { type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' },
                { type: 'text', text: 'terminal AX' },
              ],
            }
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  runner.targetWindow = { pid: 78559, window_id: 10890 }
  const observation = await runner.observe({})
  assert.equal(observation.pid, 1067)
  assert.equal(observation.window_id, 17280)
  assert.equal(runner.knownWindows.has(78559), false)
  assert.match(runner.validateExecutorCall({
    name: 'mcp__cua-driver-mcp__browser_prepare',
    arguments: { pid: 78559, window_id: 10890 },
  }), /own authorization process/)
})
test('thinking is escalated only while a step is stuck', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const click = target => ({
    done: false,
    kind: 'action',
    action: `click ${target}`,
    target,
    locate: 'ground',
  })
  const h = harness(t, {
    decisions: [
      click('任务明细'),
      click('任务明细'),
      click('添加记录'),
      click('保存'),
      { done: true, response: '已新增任务记录' },
    ],
    verifications: [{ status: 'passed', reason: '任务已新增' }],
  })
  const result = await h.run()

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(
    h.llmModes.filter((mode, index) => h.modelCalls[index] === 6000),
    [null, null, 'medium', null, null],
  )
})
test('launch resolves an application name against the installed apps', async () => {
  const calls = []
  const values = {
    list_apps: {
      apps: [
        { name: 'Lark', bundle_id: 'com.electron.lark', running: false },
        { name: 'Safari', bundle_id: 'com.apple.Safari', running: true },
      ],
    },
    launch_app: { pid: 4242 },
    list_windows: {
      windows: [{
        pid: 4242,
        window_id: 99,
        title: 'Lark',
        bounds: { width: 1200, height: 800 },
        is_on_screen: true,
        on_current_space: true,
      }],
    },
    bring_to_front: {},
  }
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        const name = call.name.replace('mcp__cua-driver-mcp__', '')
        calls.push({ name, args: JSON.parse(call.arguments) })
        return { results: [{ result: { isError: false, value: values[name] } }] }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  const execution = await runner.launchApp({}, { target: 'Lark' })
  assert.equal(execution.calls[0].status, 'succeeded')
  assert.equal(execution.response, 'Launched Lark (com.electron.lark)')
  assert.deepEqual(calls.find(call => call.name === 'launch_app').args, { bundle_id: 'com.electron.lark' })
  assert.deepEqual(runner.targetWindow, { pid: 4242, window_id: 99 })
})

test('an unmatched launch reports the installed application names', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        calls.push(batch[0].name)
        return {
          results: [{
            result: {
              isError: false,
              value: { apps: [{ name: 'Lark', bundle_id: 'com.electron.lark', running: false }] },
            },
          }],
        }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  const execution = await runner.launchApp({}, { target: 'Feishu' })
  assert.equal(execution.calls[0].status, 'failed')
  assert.match(execution.response, /no installed app matches "Feishu"/)
  assert.match(execution.response, /Lark/)
  assert.deepEqual(calls, ['mcp__cua-driver-mcp__list_apps'])
})

test('an invented bundle id is never handed to the driver', async () => {
  const calls = []
  const ctx = {
    tools: {
      execute: async ({ calls: batch }) => {
        const name = batch[0].name
        calls.push(name)
        return {
          results: [{
            result: {
              isError: false,
              value: name.endsWith('list_apps')
                ? { apps: [{ name: 'Lark', bundle_id: 'com.electron.lark', running: true }] }
                : {},
            },
          }],
        }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  const execution = await runner.launchApp({}, { target: 'com.bytedance.flybook' })
  assert.equal(execution.calls[0].status, 'failed')
  assert.match(execution.response, /no installed app matches "com.bytedance.flybook"/)
  assert.deepEqual(calls, ['mcp__cua-driver-mcp__list_apps'])
})

test('a launch without a running process is a failure', async () => {
  const ctx = {
    tools: {
      execute: async ({ calls }) => {
        const name = calls[0].name.replace('mcp__cua-driver-mcp__', '')
        const value = name === 'list_apps'
          ? { apps: [{ name: 'Lark', bundle_id: 'com.electron.lark', running: false }] }
          : { bundle_id: 'com.electron.lark', launch_state: { requested: true, process_running: false, window_ready: false } }
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  const execution = await runner.launchApp({}, { target: 'Lark' })
  assert.equal(execution.calls[0].status, 'failed')
  assert.match(execution.response, /did not start com\.electron\.lark/)
})

test('the observation carries the installed and running apps', async () => {
  const ctx = {
    tools: {
      execute: async ({ calls }) => {
        const name = calls[0].name.replace('mcp__cua-driver-mcp__', '')
        const value = name === 'get_accessibility_tree'
          ? {
              apps: [],
              windows: [{
                app_name: 'Lark', pid: 4242, window_id: 99, title: 'Lark',
                bounds: { width: 1200, height: 800 }, is_on_screen: true, on_current_space: true,
              }],
            }
          : name === 'list_apps'
            ? {
                apps: [
                  { name: 'Lark', bundle_id: 'com.electron.lark', running: true },
                  { name: 'Safari', bundle_id: 'com.apple.Safari', running: false },
                ],
              }
            : {
                structuredContent: { screenshot_width: 1, screenshot_height: 1, pid: 4242, window_id: 99 },
                content: [
                  { type: 'image', data: Buffer.from([1]).toString('base64'), mimeType: 'image/png' },
                  { type: 'text', text: 'lark AX' },
                ],
              }
        return { results: [{ result: { isError: false, value } }] }
      },
    },
  }
  const runner = new DesktopTaskRunner(ctx, {})
  const observation = await runner.observe({})
  assert.match(observation.apps, /Lark\(com\.electron\.lark;running\)/)
  assert.match(observation.apps, /Safari\(com\.apple\.Safari\)/)
  assert.equal(observation.runningApps, 'Lark(com.electron.lark)')
  assert.equal(observation.text, 'lark AX')
})
test('thinking always mode sends reasoning effort on every executor call', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const h = harness(t, {
    decisions: [
      { done: false, kind: 'action', action: 'click 保存', target: '保存', locate: 'ground' },
      { done: true, response: '已新增任务记录' },
    ],
    verifications: [{ status: 'passed', reason: '任务已新增' }],
    thinkingMode: 'always',
  })
  await h.run()
  assert.deepEqual(h.llmModes, [null, 'medium', 'medium', null])
})

test('thinking off never escalates even when a step repeats', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const click = { done: false, kind: 'action', action: 'click 任务明细', target: '任务明细', locate: 'ground' }
  const h = harness(t, {
    decisions: [click, click, { done: true, response: '已新增任务记录' }],
    verifications: [{ status: 'passed', reason: '任务已新增' }],
    thinkingMode: 'off',
  })
  await h.run()
  assert.deepEqual(h.llmModes, [null, null, null, null, null])
})

test('a batch runs several actions in one decision round', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const h = harness(t, {
    decisions: [
      {
        actions: [
          { kind: 'action', action: 'type', target: '任务名称', value: '27B模型推理优化', locate: 'ground' },
          { kind: 'action', action: 'type', target: '任务描述', value: '优化推理', locate: 'ground' },
          { kind: 'scroll', target: '任务列表', value: 'down 3' },
        ],
      },
      { done: true, response: '已填写并滚动' },
    ],
    verifications: [{ status: 'passed', reason: '完成' }],
  })
  const result = await h.run()
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(h.modelCalls, [1200, 6000, 6000, 800])
  assert.equal(h.calls.filter(call => call.name === 'type_text').length, 2)
  assert.equal(h.calls.filter(call => call.name === 'scroll').length, 1)
})

test('a failed action cancels the rest of the batch', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const click = target => ({ kind: 'action', action: `click ${target}`, target, locate: 'ground' })
  const h = harness(t, {
    decisions: [
      { actions: [click('甲'), click('乙'), click('丙')] },
      { done: true, response: '结束' },
    ],
    verifications: [{ status: 'passed', reason: '结束' }],
    failTools: ['click'],
  })
  await h.run()
  assert.equal(h.calls.filter(call => call.name === 'click').length, 1)
  assert.equal(h.calls.filter(call => call.name === 'type_text').length, 0)
})

test('an unchanged screen produces no-progress feedback on the next decision', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const click = { done: false, kind: 'action', action: 'click 个人任务', target: '个人任务', locate: 'ground' }
  const h = harness(t, {
    decisions: [click, click, { done: true, response: '结束' }],
    verifications: [{ status: 'passed', reason: '结束' }],
  })
  h.runner.observe = async () => ({
    data: new Uint8Array([1]),
    text: 'same screen',
    ref: { mediaType: 'image/png', width: 1568, height: 1091 },
    pid: 79854,
    window_id: 17971,
  })
  await h.run()
  const prompts = h.executorRequests.map(userText)
  assert.match(prompts[1], /The screen did not change after this action/)
  assert.match(prompts[2], /has not changed for 2 rounds/)
})

test('a wait step succeeds without changing adaptive thinking', async t => {
  const h = harness(t, {
    decisions: [{ done: false, kind: 'wait', value: '1' }, { done: true, response: '结束' }],
    verifications: [{ status: 'passed', reason: '结束' }],
  })
  h.runner.observe = async () => ({
    data: new Uint8Array([1]),
    text: 'same screen',
    ref: { mediaType: 'image/png', width: 1568, height: 1091 },
    pid: 79854,
    window_id: 17971,
  })
  const result = await h.run()
  const prompts = h.executorRequests.map(userText)
  assert.ok(!prompts[1].includes('The screen did not change'))
  assert.equal(result.steps[0].execution.status, 'succeeded')
  assert.deepEqual(h.llmModes, [null, null, null, null])
})

test('repeated targets get explicit feedback even when screenshots differ', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Action: click(point='(231,219)')" } }],
  }), { status: 200 }))
  const click = { done: false, kind: 'action', action: 'click 27B模型推理优化', target: '27B模型推理优化', locate: 'ground' }
  const h = harness(t, {
    decisions: [click, click, click, { done: true, response: '结束' }],
    verifications: [{ status: 'passed', reason: '结束' }],
  })
  let captures = 0
  h.runner.observe = async () => ({
    data: new Uint8Array([captures += 1]),
    text: 'same screen',
    ref: { mediaType: 'image/png', width: 1568, height: 1091 },
    pid: 79854,
    window_id: 17971,
  })
  await h.run()
  const prompts = h.executorRequests.map(userText)
  assert.match(prompts[1], /The screen did not change/)
  assert.match(prompts[2], /2 times/)
  assert.match(prompts[3], /3 times/)
  assert.match(prompts[3], /double_click/)
})
