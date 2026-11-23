import assert from 'node:assert/strict'
import test from 'node:test'
import { groundUi, parseGroundingPoint, registerGrounder } from '../../packages/desktop-agent/src/grounder.js'
import { groundingLlm } from './helpers/grounding-llm.js'

test('parse the official UI-TARS point format', () => {
  assert.deepEqual(
    parseGroundingPoint("Action: click(point='<point>400 300</point>')", 800, 600),
    { x: 400, y: 300, width: 800, height: 600 },
  )
})

test('parse the observed parenthesized point format', () => {
  assert.equal(parseGroundingPoint("Action: click(point='(308,300)')", 800, 600).x, 308)
})

test('reject missing or out-of-bounds coordinates', () => {
  assert.throws(() => parseGroundingPoint('Action: wait()', 800, 600), /no click point/)
  assert.throws(() => parseGroundingPoint('Action: click(point=(900,300))', 800, 600), /outside/)
})

test('accept a single-point start_box but reject a bounding box', () => {
  assert.equal(parseGroundingPoint("Action: click(start_box='(414,504)')", 800, 600).x, 414)
  assert.throws(
    () => parseGroundingPoint("Action: click(start_box='(231,219,300,400)')", 800, 600),
    /no click point/,
  )
})

test('accept start_box points with mismatched brackets', () => {
  assert.deepEqual(
    parseGroundingPoint("Action: click(start_box='[340,44)')", 800, 600),
    { x: 340, y: 44, width: 800, height: 600 },
  )
  assert.equal(parseGroundingPoint("Action: click(start_box='(340,44]')", 800, 600).y, 44)
})

test('the grounder tool registers with the DSH schema DSL', () => {
  const definitions = []
  registerGrounder({
    tools: { register: definition => definitions.push(definition) },
  }, { grounder: { provider: 'spark-grounder', model: 'ui-tars' } })
  assert.equal(definitions[0].name, 'desktop_ground_ui')
})

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function stubCtx(llm) {
  const saved = []
  return {
    llm,
    saved,
    attachments: {
      saveImage: async input => {
        saved.push(input)
        return { mediaType: input.mediaType, bytes: input.data.byteLength }
      },
    },
    tools: {
      execute: async () => ({
        results: [{ result: { value: { screenshot_png_b64: PNG, width: 800, height: 600 } } }],
      }),
    },
  }
}

test('the grounder goes through the DSH llm service with the screenshot attached', async () => {
  const llm = groundingLlm("Action: click(point='<point>10 20</point>')")
  const ctx = stubCtx(llm)
  const point = await groundUi(ctx, {}, {
    grounder: { provider: 'spark-grounder', model: 'ui-tars-1.5-7b' },
  }, { pid: 1, window_id: 2, instruction: '点击等于按钮' })
  assert.deepEqual(point, { x: 10, y: 20, width: 800, height: 600 })
  assert.equal(ctx.saved.length, 1)
  assert.equal(ctx.saved[0].mediaType, 'image/png')
  const request = llm.calls[0]
  assert.equal(request.provider, 'spark-grounder')
  assert.equal(request.model, 'ui-tars-1.5-7b')
  assert.equal(request.maxTokens, 100)
  assert.equal(request.temperature, 0)
  assert.equal(request.messages[0].content[0].type, 'text')
  assert.match(request.messages[0].content[0].text, /点击等于按钮/)
  assert.equal(request.messages[0].content[1].type, 'image')
  assert.equal(request.messages[0].content[1].attachment.mediaType, 'image/png')
})

test('a failed model stream is surfaced as a grounder error', async () => {
  const llm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 502' } } }
    },
  }
  await assert.rejects(
    groundUi(stubCtx(llm), {}, {
      grounder: { provider: 'spark-grounder', model: 'ui-tars-1.5-7b' },
    }, { pid: 1, window_id: 2, instruction: '点击等于按钮' }),
    /upstream 502/,
  )
})
