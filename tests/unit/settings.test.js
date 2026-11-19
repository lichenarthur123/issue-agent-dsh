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

test('local memory is off by default and its lesson cap is configurable', () => {
  const defaults = resolveDesktopSettings({}, {})
  assert.equal(defaults.memoryEnabled, false)
  assert.equal(defaults.memoryMaxLessons, 20)
  assert.equal(resolveDesktopSettings({}, { DESKTOP_MEMORY_ENABLED: 'true' }).memoryEnabled, true)
  assert.equal(resolveDesktopSettings({ memoryMaxLessons: 10 }, {}).memoryMaxLessons, 10)
  assert.equal(resolveDesktopSettings({}, { DESKTOP_MEMORY_MAX_LESSONS: '25' }).memoryMaxLessons, 25)
  assert.equal(resolveDesktopSettings({}, { DESKTOP_MEMORY_MAX_LESSONS: '0' }).memoryMaxLessons, 1)
})
