// The local session file: private to the user, per API origin, expiring, and tolerant of damage.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionStore, storeDir } from '../src/lib/session.ts'
import { COOKIE, wallet } from './fakes.ts'

const dir = () => join(mkdtempSync(join(tmpdir(), 'monfunded-session-')), 'home')

test('sessions are saved per API origin in a file only the user can read', () => {
  const store = new SessionStore(dir())
  const s = { address: wallet.address, cookie: COOKIE, expiresAt: 2_000 }
  store.save('https://monfunded.com', s)
  store.save('http://localhost:4417', { ...s, cookie: 'dd'.repeat(32) })
  assert.deepEqual(store.get('https://monfunded.com', 1_000), s)
  assert.equal(store.get('http://localhost:4417', 1_000)?.cookie, 'dd'.repeat(32))
  assert.equal(statSync(store.file).mode & 0o777, 0o600)
  assert.equal(statSync(join(store.file, '..')).mode & 0o777, 0o700)
})

test('an expired session reads as none; forgetting the last one removes the file', () => {
  const store = new SessionStore(dir())
  store.save('https://monfunded.com', { address: wallet.address, cookie: COOKIE, expiresAt: 2_000 })
  assert.equal(store.get('https://monfunded.com', 2_000), undefined)
  store.forget('https://monfunded.com')
  assert.throws(() => readFileSync(store.file))
})

test('a damaged file, or a malformed entry in it, reads as no session', () => {
  const store = new SessionStore(dir())
  store.save('https://monfunded.com', { address: wallet.address, cookie: COOKIE, expiresAt: 2_000 })
  writeFileSync(store.file, '{not json')
  assert.equal(store.get('https://monfunded.com', 1_000), undefined)
  writeFileSync(store.file, JSON.stringify({ v: 1, sessions: { 'https://monfunded.com': { address: wallet.address, cookie: 'short', expiresAt: 2_000 } } }))
  assert.equal(store.get('https://monfunded.com', 1_000), undefined)
})

test('the folder is ~/.monfunded unless MONFUNDED_AGENT_HOME moves it', () => {
  assert.match(storeDir({}), /\.monfunded$/)
  assert.equal(storeDir({ MONFUNDED_AGENT_HOME: '/tmp/x' }), '/tmp/x')
})
