import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGroundingPoint, registerGrounder } from '../../packages/desktop-agent/src/grounder.js'

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

test('the grounder tool registers with the DSH schema DSL', () => {
  const definitions = []
  registerGrounder({
    tools: { register: definition => definitions.push(definition) },
  }, { grounder: { baseURL: 'http://localhost', model: 'ui-tars' } })
  assert.equal(definitions[0].name, 'desktop_ground_ui')
})
