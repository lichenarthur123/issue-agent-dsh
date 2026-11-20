import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { groundUi, parseGroundingPoint, registerGrounder } from '../../packages/desktop-agent/src/grounder.js'

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
  }, { grounder: { baseURL: 'http://localhost', model: 'ui-tars' } })
  assert.equal(definitions[0].name, 'desktop_ground_ui')
})

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function stubCtx() {
  return {
    tools: {
      execute: async () => ({
        results: [{ result: { value: { screenshot_png_b64: PNG, width: 800, height: 600 } } }],
      }),
    },
  }
}

test('the grounder sends the gateway api key to its configured base url', async () => {
  let received
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received = { url: req.url, headers: req.headers, body: JSON.parse(body) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: "Action: click(point='<point>10 20</point>')" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const point = await groundUi(stubCtx(), {}, {
      grounder: {
        baseURL: `http://127.0.0.1:${port}/grounder/v1`,
        model: 'ui-tars-1.5-7b',
        apiKey: 'gw-key',
        timeoutMs: 600000,
      },
    }, { pid: 1, window_id: 2, instruction: '点击等于按钮' })
    assert.deepEqual(point, { x: 10, y: 20, width: 800, height: 600 })
    assert.equal(received.url, '/grounder/v1/chat/completions')
    assert.equal(received.headers['x-api-key'], 'gw-key')
    assert.equal(received.body.model, 'ui-tars-1.5-7b')
    assert.match(received.body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
  } finally {
    server.close()
  }
})

test('the grounder read timeout aborts a stalled request', async () => {
  const server = createServer(() => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await assert.rejects(
      groundUi(stubCtx(), {}, {
        grounder: { baseURL: `http://127.0.0.1:${port}/grounder/v1`, model: 'ui-tars', timeoutMs: 50 },
      }, { pid: 1, window_id: 2, instruction: '点击等于按钮' }),
      /aborted|timeout/i,
    )
  } finally {
    server.close()
  }
})
