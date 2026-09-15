// The API client: what it sends, how it reads MonFunded's errors, and what it refuses to trust.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Api } from '../src/lib/api.ts'
import { USER_AGENT } from '../src/lib/constants.ts'
import { PluginError } from '../src/lib/errors.ts'
import { BASE, config, COOKIE, fakeApi, reply, response, wallet } from './fakes.ts'

const code = (c: string) => (e: unknown) => e instanceof PluginError && e.code === c

test('requests carry the plugin’s user agent, JSON, and the session cookie once set', async () => {
  const { api, calls } = fakeApi({ 'GET /config': () => config(), 'GET /me': () => ({ address: wallet.address, active: [], past: [] }) })
  await api.config()
  assert.equal(calls[0].headers['user-agent'], USER_AGENT)
  assert.equal(calls[0].headers.accept, 'application/json')
  assert.equal(calls[0].cookie, undefined)
  api.useSession(COOKIE)
  await api.me()
  assert.equal(calls[1].cookie, COOKIE)
})

test('MonFunded’s errors become plain-words refusals; holdTime says when', async () => {
  const retryAt = Date.UTC(2026, 8, 15, 12, 1)
  const { api } = fakeApi({
    'GET /me': () => reply(401, { error: 'unauthorized' }),
    'GET /config': () => reply(409, { error: 'mystery' }),
    [`POST /${'0x' + 'a1'.repeat(32)}/close`]: () => reply(409, { error: 'holdTime', retryAt }),
  })
  await assert.rejects(api.me(), code('NOT_SIGNED_IN'))
  await assert.rejects(api.config(), (e) => code('API_ERROR')(e) && /HTTP 409 \(mystery\)/.test((e as Error).message))
  await assert.rejects(api.close(`0x${'a1'.repeat(32)}`, 'p000000000001'), (e) => code('HOLD_TIME')(e) && (e as Error).message.includes(new Date(retryAt).toISOString()))
})

test('a web page instead of JSON (a firewall challenge) is named as such', async () => {
  const api = new Api(BASE, async () => response(403, '<!DOCTYPE html><title>Just a moment...</title>'))
  await assert.rejects(api.config(), (e) => code('NOT_JSON')(e) && /HTTP 403.*Cloudflare/.test((e as Error).message))
})

test('an unreachable server, and a redirect, are network refusals', async () => {
  const api = new Api(BASE, async () => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(api.config(), (e) => code('NETWORK')(e) && (e as Error).message.includes('fetch failed'))
})

test('verify keeps the session cookie and its lifetime, and refuses an answer without one', async () => {
  const cookie = 'ab'.repeat(32)
  const good = fakeApi({ 'POST /auth/verify': () => reply(200, { address: wallet.address }, { 'set-cookie': `monfunded_session=${cookie}; Path=/; Max-Age=604800; HttpOnly; SameSite=Strict` }) })
  const before = Date.now()
  const s = await good.api.verify(wallet.address, '0x1234')
  assert.equal(s.cookie, cookie)
  assert.ok(s.expiresAt >= before + 604_800_000 && s.expiresAt <= Date.now() + 604_800_000)
  const bad = fakeApi({ 'POST /auth/verify': () => reply(200, { address: wallet.address }) })
  await assert.rejects(bad.api.verify(wallet.address, '0x1234'), code('BAD_RESPONSE'))
  const other = fakeApi({ 'POST /auth/verify': () => reply(200, { address: '0x0000000000000000000000000000000000000001' }, { 'set-cookie': `monfunded_session=${cookie}; Max-Age=60` }) })
  await assert.rejects(other.api.verify(wallet.address, '0x1234'), code('BAD_RESPONSE'))
})

test('a config naming other coins or a malformed contract is not trusted; no contract is fine', async () => {
  const withNull = fakeApi({ 'GET /config': () => config({ contract: null }) })
  assert.equal((await withNull.api.config()).contract, null)
  for (const bad of [config({ usdc: '0x0000000000000000000000000000000000000001' }), config({ contract: '0x12' as `0x${string}` }), { ...config(), tiers: [{ id: 'x', index: 300, feeUsd: 1, size: 1, rules: {} }] }]) {
    const { api } = fakeApi({ 'GET /config': () => bad })
    await assert.rejects(api.config(), code('BAD_CONFIG'))
  }
})

test('a claim proof must be a 65-byte signature, a 32-byte root and a payout coin', async () => {
  const path = `/${'0x' + 'a1'.repeat(32)}/withdrawals/${'0x' + 'b2'.repeat(32)}/claim`
  const ok = { signature: `0x${'11'.repeat(65)}`, logRoot: `0x${'22'.repeat(32)}`, token: 'USDC' }
  const good = fakeApi({ [`GET ${path}`]: () => ok })
  assert.deepEqual(await good.api.claimProof(`0x${'a1'.repeat(32)}`, `0x${'b2'.repeat(32)}`), ok)
  for (const bad of [{ ...ok, signature: '0x1234' }, { ...ok, logRoot: '0x' }, { ...ok, token: 'MON' }]) {
    const { api } = fakeApi({ [`GET ${path}`]: () => bad })
    await assert.rejects(api.claimProof(`0x${'a1'.repeat(32)}`, `0x${'b2'.repeat(32)}`), code('BAD_PROOF'))
  }
})
