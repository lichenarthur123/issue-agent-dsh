import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { LocalMemory } from '../../packages/desktop-agent/src/memory.js'

const HISTORY = [
  {
    step: 1,
    action: { kind: 'action', action: 'type the product name into the input form', target: '商品名称' },
    result: { status: 'succeeded', summary: 'filled' },
  },
  {
    step: 2,
    action: { kind: 'action', action: 'click the submit button', target: '确认上架' },
    result: { status: 'succeeded', summary: 'submitted' },
  },
]

function tempRoot(t) {
  const root = mkdtempSync(join('artifacts', 'memory-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function modelContext(responses, queries = []) {
  let index = 0
  const next = () => {
    if (typeof responses === 'function') return responses(index++)
    if (Array.isArray(responses)) return responses[index++]
    return responses
  }
  return {
    queries,
    ctx: {
      llm: {
        stream: async function* (options) {
          queries.push(options.messages[1].content[0].text)
          const text = next()
          yield { type: 'text-delta', text }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
          yield { type: 'finish', reason: { kind: 'completed' } }
        },
      },
    },
  }
}

test('memory stays disabled by default and writes nothing', async t => {
  const root = tempRoot(t)
  const memory = new LocalMemory({ root })
  const { ctx } = modelContext('# 不应调用\n- 不应写入')
  assert.equal(memory.contextFor(), '')
  assert.equal(await memory.learn(ctx, {}, { history: HISTORY, url: 'http://example.com' }), null)
  assert.equal(existsSync(join(root, 'experience.md')), false)
})

test('a task run writes one playbook file with normalized lessons', async t => {
  const root = tempRoot(t)
  const memory = new LocalMemory({ enabled: true, root })
  const { ctx, queries } = modelContext('# 表单填写经验\n* 先点击输入框再输入文本\n2. 提交前确认字段值')
  const file = await memory.learn(ctx, {}, { history: HISTORY, url: 'http://example.com/form', status: 'succeeded' })
  assert.equal(file, memory.file)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /app: Chrome/)
  assert.match(text, /runs: 1/)
  assert.match(text, /lessons: 2/)
  assert.match(text, /# 表单填写经验/)
  assert.match(text, /- 先点击输入框再输入文本/)
  assert.match(text, /- 提交前确认字段值/)
  assert.doesNotMatch(text, /^\* /m)
  assert.match(queries[0], /<outcome>succeeded<\/outcome>/)
  assert.match(queries[0], /<history>/)
})

test('each run merges previous experience and increments the run count', async t => {
  const root = tempRoot(t)
  const memory = new LocalMemory({ enabled: true, root })
  const { ctx, queries } = modelContext([
    '# 表单填写经验\n- 先点击输入框再输入文本',
    '# 表单填写经验（更新）\n- 提交前确认字段值\n- 输入后立即回读校验',
  ])
  await memory.learn(ctx, {}, { history: HISTORY, url: 'http://example.com/form' })
  await memory.learn(ctx, {}, { history: HISTORY, url: 'http://example.com/form', status: 'failed' })
  assert.match(queries[1], /<previous-experience>\n# 表单填写经验/)
  assert.match(queries[1], /<outcome>failed<\/outcome>/)
  const updated = readFileSync(join(root, 'experience.md'), 'utf8')
  assert.match(updated, /runs: 2/)
  assert.match(updated, /# 表单填写经验（更新）/)
  assert.doesNotMatch(updated, /先点击输入框再输入文本/)
})

test('summaries never persist urls, credentials or personal data', async t => {
  const root = tempRoot(t)
  const memory = new LocalMemory({ enabled: true, root })
  const { ctx } = modelContext([
    '# 登录后填写',
    '- 访问 https://secret.example.com/private?token=abc 后填写表单',
    '- 账号 user@example.com，手机 13800138000，password=hunter2',
  ].join('\n'))
  await memory.learn(ctx, {}, { history: HISTORY, url: 'http://example.com' })
  const text = readFileSync(join(root, 'experience.md'), 'utf8')
  assert.doesNotMatch(text, /secret\.example\.com/)
  assert.doesNotMatch(text, /user@example\.com/)
  assert.doesNotMatch(text, /13800138000/)
  assert.doesNotMatch(text, /hunter2/)
  assert.match(text, /\[url\]/)
})

test('lesson count is capped and the injected body has no frontmatter', async t => {
  const root = tempRoot(t)
  const memory = new LocalMemory({ enabled: true, root, maxLessons: 20 })
  const bullets = Array.from({ length: 25 }, (_, index) => `- 经验 ${index + 1}`).join('\n')
  const { ctx } = modelContext(`# 经验合集\n${bullets}`)
  await memory.learn(ctx, {}, { history: HISTORY, url: 'http://example.com' })
  const text = readFileSync(join(root, 'experience.md'), 'utf8')
  assert.match(text, /lessons: 20/)
  assert.equal(text.split('\n').filter(line => line.startsWith('- ')).length, 20)
  assert.doesNotMatch(text, /经验 21/)
  const context = memory.contextFor()
  assert.match(context, /^# 经验合集/)
  assert.doesNotMatch(context, /^---/)
  assert.doesNotMatch(context, /runs:/)
})

test('the injected playbook respects its byte budget', async t => {
  const root = tempRoot(t)
  const memory = new LocalMemory({ enabled: true, root, maxBytes: 300 })
  writeFileSync(join(root, 'experience.md'), [
    '---',
    'app: Chrome',
    'runs: 1',
    '---',
    `# 大条目\n- ${'操'.repeat(300)}`,
    '',
  ].join('\n'))
  const context = memory.contextFor()
  assert.ok(Buffer.byteLength(context) <= 300)
})

test('a summary without a Markdown title is rejected and no file is written', async t => {
  const root = tempRoot(t)
  const memory = new LocalMemory({ enabled: true, root })
  const { ctx } = modelContext('只有标题之外的普通文本')
  await assert.rejects(memory.learn(ctx, {}, { history: HISTORY, url: 'http://example.com' }), /no usable Markdown/)
  assert.equal(existsSync(join(root, 'experience.md')), false)
})