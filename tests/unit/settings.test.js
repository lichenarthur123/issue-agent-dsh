import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDesktopSettings } from '../../packages/desktop-agent/src/settings.js'

test('planner expansion is disabled by default and can be enabled explicitly', () => {
  assert.equal(resolveDesktopSettings({}, {}).plannerEnabled, false)
  assert.equal(resolveDesktopSettings({ plannerEnabled: true }, {}).plannerEnabled, true)
  assert.equal(resolveDesktopSettings({}, { DESKTOP_PLANNER_ENABLED: 'true' }).plannerEnabled, true)
  assert.equal(resolveDesktopSettings({ plannerEnabled: true }, { DESKTOP_PLANNER_ENABLED: 'false' }).plannerEnabled, false)
})

test('browser profile defaults to the local profile and supports isolated fallbacks', () => {
  assert.deepEqual(resolveDesktopSettings({}, {}).browserProfile, {
    mode: 'existing_profile',
    name: 'issue-agent',
    app: 'Google Chrome',
    lang: 'en-US',
  })
  assert.equal(resolveDesktopSettings({}, { DESKTOP_BROWSER_PROFILE_MODE: 'isolated_new' }).browserProfile.mode, 'isolated_new')
  assert.equal(resolveDesktopSettings({}, { DESKTOP_BROWSER_PROFILE_MODE: 'isolated_named' }).browserProfile.mode, 'isolated_named')
  assert.equal(resolveDesktopSettings({}, { DESKTOP_BROWSER_PROFILE_MODE: 'invalid' }).browserProfile.mode, 'existing_profile')
})

test('the grounder routes through the gateway with an api key and a long read timeout', () => {
  const settings = resolveDesktopSettings({}, { GW_KEY: 'gw-key' })
  assert.equal(settings.grounder.baseURL, 'http://39.97.8.6:8080/grounder/v1')
  assert.equal(settings.grounder.apiKey, 'gw-key')
  assert.equal(settings.grounder.timeoutMs, 600000)
})

test('grounder settings honor apiKeyEnv, explicit key, and LAN fallbacks', () => {
  const config = { grounder: { baseURL: 'http://gw/grounder/v1', apiKeyEnv: 'SOME_KEY', timeoutMs: 120000 } }
  assert.equal(resolveDesktopSettings(config, { SOME_KEY: 'k' }).grounder.apiKey, 'k')
  assert.equal(resolveDesktopSettings(config, { DESKTOP_GROUNDER_API_KEY: 'direct' }).grounder.apiKey, 'direct')
  assert.equal(resolveDesktopSettings(config, { DESKTOP_GROUNDER_TIMEOUT_SECONDS: '30' }).grounder.timeoutMs, 30000)
  assert.equal(resolveDesktopSettings(config, {}).grounder.timeoutMs, 120000)
  const lan = resolveDesktopSettings(
    { grounder: { baseURL: 'http://10.10.10.1:8003/v1' } },
    { DESKTOP_GROUNDER_API_KEY_ENV: '' },
  )
  assert.equal(lan.grounder.baseURL, 'http://10.10.10.1:8003/v1')
  assert.equal('apiKey' in lan.grounder, false)
})

test('local memory is off by default and its lesson cap is configurable', () => {
  const defaults = resolveDesktopSettings({}, {})
  assert.equal(defaults.memoryEnabled, false)
  assert.equal(defaults.memoryMaxLessons, 20)
  assert.equal(resolveDesktopSettings({}, { DESKTOP_MEMORY_ENABLED: 'true' }).memoryEnabled, true)
  assert.equal(resolveDesktopSettings({ memoryMaxLessons: 10 }, {}).memoryMaxLessons, 10)
  assert.equal(resolveDesktopSettings({}, { DESKTOP_MEMORY_MAX_LESSONS: '25' }).memoryMaxLessons, 25)
  assert.equal(resolveDesktopSettings({}, { DESKTOP_MEMORY_MAX_LESSONS: '0' }).memoryMaxLessons, 1)
})
