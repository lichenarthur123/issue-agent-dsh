import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComment } from '../../packages/git-issue-agent/src/github.js'
import { compactHistory } from '../../packages/desktop-agent/src/history.js'
import { parsePlannerDecision } from '../../packages/desktop-agent/src/planner.js'
import { buildExecutorPrompt, EXECUTOR_SYSTEM, executorSystem } from '../../packages/desktop-agent/src/prompt.js'
import { PROMPT_LIMITS, SCREENSHOT_PROMPT_BUDGET } from '../../packages/desktop-agent/src/prompt-budget.js'
import { logModelEnd, logModelStart } from '../../packages/desktop-agent/src/log.js'

const record = {
  repository: 'acme/desktop',
  issue: { number: 1, title: 'Calculate', body: 'Open Calculator and calculate 5 + 5', user: { login: 'alice' } },
}

test('parse one executable executor decision', () => {
  const decision = parsePlannerDecision('{"done":false,"action":"打开计算器"}')
  assert.deepEqual(decision, {
    done: false,
    kind: 'action',
    action: '打开计算器',
    url: '',
    target: '',
    value: '',
    locate: 'ax',
    response: '',
  })
})

test('parse a structured navigation', () => {
  const decision = parsePlannerDecision('{"done":false,"kind":"navigate","action":"打开 AmaShop","url":"http://127.0.0.1:8765/#/home"}')
  assert.equal(decision.kind, 'navigate')
  assert.equal(decision.url, 'http://127.0.0.1:8765/#/home')
})

test('duplicate empty target and value do not erase the actionable fields', () => {
  const decision = parsePlannerDecision('{"done":false,"action":"type","target":"商品名称","value":"成人纸尿裤","target":"","value":""}')
  assert.equal(decision.target, '商品名称')
  assert.equal(decision.value, '成人纸尿裤')
})

test('parse a final executor response', () => {
  const decision = parsePlannerDecision('```json\n{"done":true,"response":"2"}\n```')
  assert.equal(decision.done, true)
  assert.equal(decision.response, '2')
  assert.equal(decision.blocked, false)
})

test('reject a decision without an action', () => {
  assert.throws(() => parsePlannerDecision('{"done":false,"action":""}'), /action is required/)
})

test('derive the action label for navigation and app launch', () => {
  const navigate = parsePlannerDecision('{"done":false,"kind":"navigate","url":"http://127.0.0.1:8765/#/home"}')
  assert.equal(navigate.action, 'Navigate to http://127.0.0.1:8765/#/home')
  const launch = parsePlannerDecision('{"done":false,"kind":"launch","target":"com.apple.Safari"}')
  assert.equal(launch.action, 'Launch com.apple.Safari')
  assert.throws(
    () => parsePlannerDecision('{"done":false,"kind":"launch"}'),
    /bundle id in target/,
  )
})

test('tolerate omitted done and locate flags', () => {
  const decision = parsePlannerDecision('{"kind":"navigate","action":"navigate","url":"http://127.0.0.1:8765/#/home"}')
  assert.equal(decision.done, false)
  assert.equal(decision.locate, 'ax')
  assert.equal(decision.kind, 'navigate')
})

test('parse a dropdown selection and require its option text', () => {
  const decision = parsePlannerDecision('{"kind":"select","target":"分类 *","value":"家居生活"}')
  assert.equal(decision.kind, 'select')
  assert.equal(decision.action, 'Select 家居生活 in 分类 *')
  assert.throws(
    () => parsePlannerDecision('{"kind":"select","target":"分类 *"}'),
    /option text in value/,
  )
})

test('derive the action label for an action decision from target and value', () => {
  const click = parsePlannerDecision('{"kind":"action","target":"发布 SKU","locate":"ax"}')
  assert.equal(click.action, 'Click 发布 SKU')
  const type = parsePlannerDecision('{"kind":"action","target":"商品名称 *","value":"成人纸尿裤"}')
  assert.equal(type.action, 'Type 成人纸尿裤 into 商品名称 *')
})

test('parse a decision from a thinking model response', () => {
  const withReasoning = parsePlannerDecision('先分析当前屏幕：{可见元素: 终端}，需要打开网站。\n最终决策：\n{"kind":"navigate","url":"http://127.0.0.1:8765/#/home"}')
  assert.equal(withReasoning.kind, 'navigate')
  assert.equal(withReasoning.action, 'Navigate to http://127.0.0.1:8765/#/home')
  const fenced = parsePlannerDecision('推理过程……\n```json\n{"done":true,"response":"完成"}\n```')
  assert.equal(fenced.done, true)
  assert.equal(fenced.response, '完成')
})

test('parse the grounding locator for an action', () => {
  const decision = parsePlannerDecision('{"kind":"action","action":"点击画布","target":"画布","locate":"ground"}')
  assert.equal(decision.locate, 'ground')
  assert.equal(parsePlannerDecision('{"kind":"action","action":"点击","target":"确定"}').locate, 'ax')
})

test('the executor receives the full plan, compact history, and only the current screen', () => {
  const history = [{
    step: 1,
    action: { kind: 'navigate', action: '打开 AmaShop', url: 'http://127.0.0.1:8765/#/home' },
    result: { status: 'succeeded', summary: 'Navigated to http://127.0.0.1:8765/#/home', output: 'full tool output that must not be replayed' },
    observation: { text: 'AX from the previous round' },
  }]
  const prompt = buildExecutorPrompt({
    request: '上架商品',
    plan: '1. 打开 AmaShop\n2. 填写商品名称',
    history,
    observation: { text: 'AX from the current round' },
  })
  assert.match(prompt, /<execution-plan>\n1\. 打开 AmaShop\n2\. 填写商品名称\n<\/execution-plan>/)
  assert.match(prompt, /"step":1/)
  assert.match(prompt, /"summary":"Navigated to http:\/\/127\.0\.0\.1:8765\/#\/home"/)
  assert.match(prompt, /<current-ax>AX from the current round<\/current-ax>/)
  assert.doesNotMatch(prompt, /AX from the previous round/)
  assert.doesNotMatch(prompt, /full tool output that must not be replayed/)

  const compact = compactHistory([{
    step: 2,
    action: { kind: 'action', action: 'type', target: '商品名称', value: '成人纸尿裤', locate: 'ground' },
    result: { status: 'failed', error: 'grounder returned no click point', calls: [{ tool: 'click', status: 'failed' }] },
  }])
  assert.deepEqual(compact, [{
    step: 2,
    action: { kind: 'action', action: 'type', target: '商品名称', value: '成人纸尿裤', locate: 'ground' },
    result: { status: 'failed', error: 'grounder returned no click point' },
  }])
})

test('model logs include the returned tool call and arguments', t => {
  const lines = []
  t.mock.method(console, 'error', line => { lines.push(line) })
  logModelEnd({ model: 'executor' }, Date.now(), { inputTokens: 10, outputTokens: 2 }, [{
    type: 'tool-call',
    name: 'mcp__cua-driver-mcp__click',
    arguments: '{"pid":123,"window_id":456}',
  }])
  assert.match(lines[1], /executor response=mcp__cua-driver-mcp__click\(\{"pid":123,"window_id":456\}\)/)
})

test('the issue comment includes the executed steps', () => {
  const body = buildComment({
    repository: 'acme/desktop',
    issue: record.issue,
    result: {
      status: 'unverified',
      sessionId: 's-1',
      durationMs: 10,
      answer: '10',
      plan: '1. 打开计算器',
    },
  })
  assert.match(body, /\*\*CUA plan\*\*/)
  assert.match(body, /打开计算器/)
})
test('a trailing newline survives parsing so the runtime can submit', () => {
  const decision = parsePlannerDecision('{"done":false,"kind":"action","action":"run a command","target":"终端输入区域","value":"open -a Lark\\n","locate":"ground"}')
  assert.equal(decision.value, 'open -a Lark\n')
})

test('a blocked report without an action is a terminal blocked result', () => {
  const decision = parsePlannerDecision('<attempt-completion>{"done":false,"blocked":true,"response":"点击添加记录后没有出现录入面板"}</attempt-completion>')
  assert.equal(decision.done, true)
  assert.equal(decision.blocked, true)
  assert.equal(decision.response, '点击添加记录后没有出现录入面板')
})

test('a blocked report without a response falls back to the prose before the json', () => {
  const decision = parsePlannerDecision('页面没有加载完成，无法继续。\n{"done":false,"blocked":true}')
  assert.equal(decision.blocked, true)
  assert.match(decision.response, /页面没有加载完成/)
})

test('wait, scroll, and key decisions derive their action and fields', () => {
  const wait = parsePlannerDecision('{"done":false,"kind":"wait","value":"3"}')
  assert.equal(wait.action, 'Wait 3s')
  assert.equal(wait.seconds, 3)
  const scroll = parsePlannerDecision('{"done":false,"kind":"scroll","target":"任务明细","value":"page down 2"}')
  assert.equal(scroll.direction, 'down')
  assert.equal(scroll.amount, 2)
  assert.equal(scroll.by, 'page')
  assert.equal(scroll.action, 'Scroll down 2 page in 任务明细')
  const key = parsePlannerDecision('{"done":false,"kind":"key","value":"cmd+s"}')
  assert.equal(key.value, 'cmd+s')
  assert.equal(key.action, 'Press cmd+s')
})

test('an unknown kind is rejected with the supported list', () => {
  assert.throws(
    () => parsePlannerDecision('{"done":false,"kind":"move","target":"窗口"}'),
    /unsupported kind "move"/,
  )
})

test('click variants and drag require their labels', () => {
  assert.throws(() => parsePlannerDecision('{"done":false,"kind":"double_click"}'), /requires the target label/)
  assert.throws(() => parsePlannerDecision('{"done":false,"kind":"drag","target":"滑块"}'), /destination label/)
  const drag = parsePlannerDecision('{"done":false,"kind":"drag","target":"滑块","value":"最右端","locate":"ground"}')
  assert.equal(drag.action, 'Drag 滑块 to 最右端')
})
test('screenshot observation mode drops the AX payload from the executor prompt', () => {
  const base = {
    request: '打开飞书',
    plan: '1. 打开飞书',
    observation: { text: 'AXButton "保存"', runningApps: '飞书(com.electron.lark)' },
  }
  const hybrid = buildExecutorPrompt(base)
  assert.match(hybrid, /<current-ax>AXButton "保存"<\/current-ax>/)
  const screenshot = buildExecutorPrompt({ ...base, observationMode: 'screenshot' })
  assert.ok(!screenshot.includes('<current-ax>'))
  assert.match(screenshot, /<running-apps>/)
  assert.match(screenshot, /<execution-plan>/)
  assert.match(executorSystem('screenshot'), /Always set locate="ground"/)
  assert.ok(!executorSystem('screenshot').includes('accessibility tree is provided. Read'))
  assert.match(EXECUTOR_SYSTEM, /locate=ax \(the default\)/)
})

test('screenshot mode includes expanded business JSON without restoring the AX tree', () => {
  const stateJson = JSON.stringify({ cart: [{ productId: 'SKU-1001', qty: 3 }], orders: [], products: [], lastAction: '加入购物车 SKU-1001 × 3' })
  const prompt = buildExecutorPrompt({
    request: '完成后把业务状态 JSON 放在回复最后',
    observation: { text: 'full AX must stay out', stateJson },
    observationMode: 'screenshot',
  })
  assert.match(prompt, /<current-state-json>.*SKU-1001.*<\/current-state-json>/)
  assert.ok(!prompt.includes('full AX must stay out'))
  assert.match(executorSystem('screenshot'), /copy that JSON verbatim/)
})

test('history keeps five full steps and summarizes the omitted steps', () => {
  const history = Array.from({ length: 8 }, (_, index) => ({
    step: index + 1,
    action: { kind: 'action', action: `a${index + 1}`, target: 'x', value: '' },
    result: { status: 'succeeded', summary: 'ok' },
  }))
  const compact = compactHistory(history)
  assert.equal(compact.length, 5)
  assert.equal(compact[0].step, 4)
  assert.equal(compact.at(-1).step, 8)
  const prompt = buildExecutorPrompt({ request: 't', plan: 'p', history, observationMode: 'screenshot' })
  assert.match(prompt, /<history-summary>#1 action a1 -> succeeded/)
  assert.match(prompt, /#3 action a3 -> succeeded/)
  assert.match(prompt, /3 earlier steps are summarized above/)
  const short = buildExecutorPrompt({ request: 't', plan: 'p', history: history.slice(0, 3), observationMode: 'screenshot' })
  assert.ok(!short.includes('<history-omitted>'))
  assert.ok(!short.includes('<history-summary>'))
})

test('large prompt sections are explicitly truncated and past feedback is retained', () => {
  const prompt = buildExecutorPrompt({
    request: 'r'.repeat(PROMPT_LIMITS.task + 100),
    plan: 'p',
    feedbackHistory: [{ status: 'failed', reason: 'old failure' }],
    observation: { text: 'a'.repeat(PROMPT_LIMITS.ax + 100) },
  })
  assert.match(prompt, /truncated: showing first 8000 of 8100 characters/)
  assert.match(prompt, /truncated: showing first 12000 of 12100 characters/)
  assert.match(prompt, /<feedback-history>\[\{"status":"failed","reason":"old failure"\}\]<\/feedback-history>/)

  const capped = buildExecutorPrompt({
    request: 't',
    plan: 'p',
    observation: { text: 'AX', elements: [{}, {}, {}], maxElements: 3 },
  })
  assert.match(capped, /AX capture is capped at 3 elements; the tree may be incomplete/)
})

test('screenshot mode enforces the user and history byte budgets', () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    step: index + 1,
    action: { kind: 'action', action: `步骤${index} ${'汉'.repeat(200)}`, target: '目标', value: '值'.repeat(300) },
    result: { status: 'failed', summary: '结果'.repeat(100), error: '错误'.repeat(200) },
  }))
  const prompt = buildExecutorPrompt({
    request: '任'.repeat(5000),
    plan: '计'.repeat(10000),
    history,
    targetWindow: { pid: 1, window_id: 2 },
    pageTarget: { session: 's', pid: 1, windowId: 2 },
    feedback: { status: 'failed', reason: '错'.repeat(1000) },
    feedbackHistory: Array.from({ length: 5 }, () => ({ status: 'failed', reason: '旧错误'.repeat(200) })),
    observation: {
      runningApps: 'App(com.app);'.repeat(500),
      text: 'AX must not be injected',
      ref: { width: 100, height: 100 },
    },
    observationMode: 'screenshot',
  })
  assert.ok(Buffer.byteLength(prompt) <= SCREENSHOT_PROMPT_BUDGET.userBytes + SCREENSHOT_PROMPT_BUDGET.historyBytes)
  assert.ok(!prompt.includes('<current-ax>'))
  assert.ok(!prompt.includes('<feedback-history>'))
  assert.match(prompt, /truncated:/)
  assert.match(prompt, /Decide the single next atomic action/)
  assert.ok(Buffer.byteLength(executorSystem('screenshot')) <= SCREENSHOT_PROMPT_BUDGET.systemBytes)
})

test('model logs include cache hits only when the provider reports them', t => {
  const lines = []
  t.mock.method(console, 'error', line => { lines.push(line) })
  logModelEnd({ model: 'executor' }, Date.now(), { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80 })
  assert.match(lines[0], /input=180 cache=80 output=5/)
  lines.length = 0
  logModelEnd({ model: 'executor' }, Date.now(), { inputTokens: 100, outputTokens: 5 })
  assert.match(lines[0], /input=100 cache=0 output=5/)
  lines.length = 0
  logModelEnd({ model: 'executor' }, Date.now(), {
    prompt_tokens: 2576,
    completion_tokens: 2,
    prompt_tokens_details: { cached_tokens: 1600 },
  })
  assert.match(lines[0], /input=2576 cache=1600 output=2/)
})

test('model call logs include per-part input byte sizes', t => {
  const lines = []
  t.mock.method(console, 'error', line => { lines.push(line) })
  logModelStart({ model: 'executor' }, {
    thinking: true,
    parts: { sys: 3566, user: 1252, history: 800, image: 919008 },
  })
  assert.match(lines[0], /call executor thinking \| sys=3566B user=1252B history=800B image=919008B/)
  lines.length = 0
  logModelStart({ model: 'planner' }, { parts: { sys: 100, user: 200 } })
  assert.match(lines[0], /call planner \| sys=100B user=200B/)
  assert.ok(!lines[0].includes('history='))
  assert.ok(!lines[0].includes('image='))
})

test('a batch of up to three serial decisions is parsed', () => {
  const decision = parsePlannerDecision('{"done":false,"actions":[{"kind":"action","action":"type","target":"任务名称","value":"27B模型推理优化","locate":"ground"},{"kind":"action","action":"type","target":"任务描述","value":"优化推理","locate":"ground"},{"kind":"scroll","target":"任务列表","value":"down 3"}]}')
  assert.equal(decision.kind, 'batch')
  assert.equal(decision.actions.length, 3)
  assert.equal(decision.actions[0].target, '任务名称')
  assert.equal(decision.actions[2].kind, 'scroll')
  assert.match(decision.action, /→/)
})

test('batches are capped at three and cannot hold a terminal decision', () => {
  const many = parsePlannerDecision(`{"actions":[${'{"kind":"key","value":"tab"},'.repeat(4).replace(/,$/, '')}]}`)
  assert.equal(many.actions.length, 3)
  assert.throws(() => parsePlannerDecision('{"actions":[{"done":true,"response":"x"}]}'), /single decision/)
  assert.throws(() => parsePlannerDecision('{"actions":[]}'), /1 to 3/)
  const batch = parsePlannerDecision('{"actions":[{"kind":"action","target":"数量","value":"15","expect":{"value":10},"observeAfter":true}]}')
  assert.deepEqual(batch.actions[0].expect, { value: '10' })
  assert.equal(batch.actions[0].observeAfter, true)
})

test('an executor supplied point is parsed into the decision', () => {
  const decision = parsePlannerDecision('{"kind":"action","action":"click","target":"重要紧急","locate":"ground","point":[940,657]}')
  assert.deepEqual(decision.point, { x: 940, y: 657 })
  const noPoint = parsePlannerDecision('{"kind":"action","action":"click","target":"保存","locate":"ground"}')
  assert.equal(noPoint.point, undefined)
})

test('normalized_1000 mode documents the coordinate contract in the system prompt', () => {
  assert.match(executorSystem('screenshot', 'normalized_1000'), /normalized coordinates in the range 0-1000/)
  assert.match(executorSystem('screenshot', 'normalized_1000'), /NOT pixels/)
  assert.match(executorSystem('screenshot', 'pixels'), /in pixels of the current screenshot/)
})
