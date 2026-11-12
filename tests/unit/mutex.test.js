import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DesktopMutex } from '../../packages/desktop-agent/src/mutex.js'

function fixture(t) {
  mkdirSync('.tools', { recursive: true })
  const directory = mkdtempSync(join(process.cwd(), '.tools', 'mutex-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'desktop.lock')
}

test('only one owner can hold the desktop lock', t => {
  const mutex = new DesktopMutex(fixture(t))
  mutex.acquire('first')
  mutex.acquire('first')
  assert.throws(() => mutex.acquire('second'), error => error.code === 'DESKTOP_BUSY')
  mutex.release('first')
  mutex.acquire('second')
  mutex.release('second')
})

test('a lock left by an exited process is recovered', t => {
  const lockFile = fixture(t)
  writeFileSync(lockFile, JSON.stringify({ token: 'stale', pid: 1073741824 }))
  const mutex = new DesktopMutex(lockFile)
  mutex.acquire('current')
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).owner, 'current')
  mutex.release('current')
})
