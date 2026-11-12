import assert from 'node:assert/strict'
import test from 'node:test'
import { createPolicy, normalizeShortcut } from '../../packages/desktop-agent/src/policy.js'

const cua = name => `mcp__cua-driver-mcp__${name}`

test('normalizeShortcut folds modifier aliases', () => {
  assert.equal(normalizeShortcut('Command+Shift+Q'), normalizeShortcut('shift+cmd+q'))
  assert.equal(normalizeShortcut('alt+tab'), normalizeShortcut('option+tab'))
})

test('a blocked tool is denied', () => {
  const policy = createPolicy({ blockedTools: ['kill_app'] })
  assert.match(policy.check(cua('kill_app'), { bundle_id: 'com.apple.Safari' }), /^POLICY_DENIED: kill_app/)
  assert.equal(policy.check(cua('click'), { x: 1, y: 2 }), undefined)
})

test('a blocked shortcut is denied as a string', () => {
  const policy = createPolicy({ blockedShortcuts: ['cmd+q'] })
  assert.match(policy.check(cua('hotkey'), { combo: 'cmd+q' }), /POLICY_DENIED/)
  assert.match(policy.check(cua('hotkey'), { keys: ['command', 'q'] }), /POLICY_DENIED/)
})

test('a blocked shortcut is denied from key plus modifiers', () => {
  const policy = createPolicy({ blockedShortcuts: ['cmd+q'] })
  assert.match(policy.check(cua('press_key'), { key: 'q', modifiers: ['command'] }), /POLICY_DENIED/)
})

test('typing text that looks like a shortcut is allowed', () => {
  const policy = createPolicy({ blockedShortcuts: ['cmd+q'] })
  assert.equal(policy.check(cua('type_text'), { text: 'cmd+q' }), undefined)
})

test('allowedApps restricts launch_app', () => {
  const policy = createPolicy({ allowedApps: ['com.apple.calculator'] })
  assert.equal(policy.check(cua('launch_app'), { bundle_id: 'com.apple.calculator' }), undefined)
  assert.match(policy.check(cua('launch_app'), { bundle_id: 'com.apple.Terminal' }), /not in allowedApps/)
})

test('allowedUrlHosts restricts browser_navigate', () => {
  const policy = createPolicy({ allowedUrlHosts: ['example.test'] })
  assert.equal(policy.check(cua('browser_navigate'), { url: 'https://app.example.test/path' }), undefined)
  assert.match(policy.check(cua('browser_navigate'), { url: 'https://evil.test/' }), /not in allowedUrlHosts/)
})

test('non-cua tools are never checked', () => {
  const policy = createPolicy()
  assert.equal(policy.check('shell', { command: 'rm -rf /' }), undefined)
})

test('empty policy rules leave every desktop call allowed', () => {
  const policy = createPolicy({ blockedTools: [], blockedShortcuts: [] })
  assert.equal(policy.check(cua('kill_app'), { bundle_id: 'com.apple.Safari' }), undefined)
  assert.deepEqual(policy.rules.allowedApps, [])
})