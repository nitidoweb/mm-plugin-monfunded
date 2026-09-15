// coach, order and close against a stand-in API.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PluginError } from '../src/lib/errors.ts'
import { close, coach, order } from '../src/lib/trade.ts'
import type { Position } from '../src/lib/types.ts'
import { account, ACCOUNT_ID, fakeApi, makeDeps, PRICES, progress, T0, wallet } from './fakes.ts'

const code = (c: string) => (e: unknown) => e instanceof PluginError && e.code === c
type Routes = Parameters<typeof fakeApi>[0]
const routes = (over: Routes = {}): Routes => ({ 'GET /me': () => ({ address: wallet.address, active: [account()], past: [] }), 'GET /prices': () => PRICES, ...over })
const BTC_LONG = { market: 'perpl:BTC', side: 'long', notional: 1000, leverage: 2 } as const

test('coach blocks what the server would refuse: the leverage cap (plan’s or Perpl’s), a closed or unknown market, margin', async () => {
  const { d } = makeDeps(fakeApi(routes()).api)
  const lev = await coach(d, { ...BTC_LONG, leverage: 16 })
  assert.equal(lev.verdict, 'blocked')
  assert.match(lev.summary[0], /16x is above the 15x cap on BTC \(the plan allows 100x, Perpl 15x\)/)
  const lit = await coach(d, { ...BTC_LONG, market: 'perpl:LIT', leverage: 4 })
  assert.match(lit.summary[0], /4x is above the 3x cap on LIT/)
  const zec = await coach(d, { ...BTC_LONG, market: 'perpl:ZEC' })
  assert.equal(zec.verdict, 'blocked')
  assert.equal(zec.checks.find((c) => c.check === 'market')?.ok, false)
  const doge = await coach(d, { ...BTC_LONG, market: 'perpl:DOGE' })
  assert.equal(doge.verdict, 'blocked')
  assert.equal(doge.risk, undefined)
  const big = await coach(d, { ...BTC_LONG, notional: 30_000, leverage: 5 })
  assert.equal(big.checks.find((c) => c.check === 'margin')?.ok, false)
})

test('coach on a forex pair: the plan’s forex cap and MonFunded liquidity’s own, named as the source', async () => {
  const { d } = makeDeps(fakeApi(routes()).api)
  const over = await coach(d, { market: 'fx:USDJPY', side: 'long', notional: 1000, leverage: 31 })
  assert.equal(over.verdict, 'blocked')
  assert.match(over.summary[0], /31x is above the 30x cap on USD\/JPY \(the plan allows 30x, MonFunded liquidity 30x\)\./)
  const fine = await coach(d, { market: 'fx:USDJPY', side: 'long', notional: 1000, leverage: 30 })
  assert.equal(fine.checks.find((c) => c.check === 'leverage')?.ok, true)
  assert.ok(fine.summary.some((line) => line.includes('It fills at the next MonFunded liquidity quote, near 155.108 (the ask)')), fine.summary.join(' | '))
})

test('coach measures the move that fails the account and the one that liquidates the position', async () => {
  const { d } = makeDeps(fakeApi(routes()).api)
  const ok = await coach(d, BTC_LONG)
  assert.equal(ok.verdict, 'ok')
  assert.equal(ok.risk?.entryPrice, 60_001)
  assert.equal(ok.risk?.failsOn, 'daily loss')
  assert.equal(ok.risk?.failMovePct, 15)
  assert.equal(ok.risk?.liquidationMovePct, 45)
  assert.equal(ok.risk?.roundTripSpreadUsd, 0.03)
  assert.match(ok.summary.join('\n'), /The account fails before this position’s liquidation point/)
  const risky = await coach(d, { ...BTC_LONG, notional: 20_000, leverage: 5 })
  assert.equal(risky.verdict, 'caution')
  assert.equal(risky.risk?.failMovePct, 0.75)
  assert.match(risky.summary.join('\n'), /Caution/)
})

test('order sends the order and waits for its fill', async () => {
  const pending: Position = { id: 'p00000000000a', marketId: 'perpl:BTC', side: 'short', status: 'pending', notional: 500, leverage: 2, margin: 250, requestedAt: T0 }
  let polls = 0
  const { api, calls } = fakeApi(
    routes({
      [`POST /${ACCOUNT_ID}/orders`]: () => ({ challenge: account({ positions: [pending] }), position: pending }),
      [`GET /${ACCOUNT_ID}`]: () => account({ positions: [++polls < 2 ? pending : { ...pending, status: 'open', entryPrice: 59_999, openedAt: T0 + 1000 }] }),
    }),
  )
  const r = await order(makeDeps(api).d, { ...BTC_LONG, side: 'short', notional: 500 })
  assert.deepEqual(calls.find((c) => c.path.endsWith('/orders'))?.body, { marketId: 'perpl:BTC', side: 'short', notional: 500, leverage: 2 })
  assert.equal(r.position.status, 'open')
  assert.equal(r.position.entryPrice, 59_999)
  assert.equal(polls, 2)
  assert.match(r.summary[1], /mm monfunded close --position p00000000000a/)
})

test('order refuses without sending: over the cap, no account, or several without --account', async () => {
  const cases: [Routes, string][] = [
    [routes(), 'LEVERAGE_TOO_HIGH'],
    [routes({ 'GET /me': () => ({ address: wallet.address, active: [], past: [] }) }), 'NO_ACCOUNT'],
    [routes({ 'GET /me': () => ({ address: wallet.address, active: [account(), account({ id: `0x${'b2'.repeat(32)}`, status: 'funded' })], past: [] }) }), 'WHICH_ACCOUNT'],
  ]
  for (const [r, expected] of cases) {
    const { api, calls } = fakeApi(r)
    await assert.rejects(order(makeDeps(api).d, { ...BTC_LONG, leverage: expected === 'LEVERAGE_TOO_HIGH' ? 16 : 2 }), code(expected))
    assert.ok(!calls.some((c) => c.path.endsWith('/orders')), expected)
  }
})

test('close waits out the 60 s minimum hold without asking the server', async () => {
  const open: Position = { id: 'p00000000000b', marketId: 'perpl:BTC', side: 'long', status: 'open', notional: 1000, leverage: 2, margin: 500, requestedAt: T0 - 31_000, entryPrice: 60_000, openedAt: T0 - 30_000 }
  const { api, calls } = fakeApi(routes({ 'GET /me': () => ({ address: wallet.address, active: [account({ positions: [open] })], past: [] }) }))
  await assert.rejects(close(makeDeps(api).d, { position: open.id }), (e) => code('HOLD_TIME')(e) && /\(in 30 s\)/.test((e as Error).message))
  assert.ok(!calls.some((c) => c.path.endsWith('/close')))
  await assert.rejects(close(makeDeps(api).d, { position: 'p0000000000ff' }), code('POSITION_NOT_FOUND'))
})

test('close sends the close, waits for it, and reports a pass', async () => {
  const open: Position = { id: 'p00000000000c', marketId: 'perpl:BTC', side: 'long', status: 'open', notional: 25_000, leverage: 5, margin: 5000, requestedAt: T0 - 62_000, entryPrice: 60_000, openedAt: T0 - 61_000 }
  const closed: Position = { ...open, status: 'closed', exitPrice: 61_200, closedAt: T0 + 500, pnl: 500, closedBy: 'trader' }
  const { api, calls } = fakeApi(
    routes({
      'GET /me': () => ({ address: wallet.address, active: [account({ positions: [open] })], past: [] }),
      [`POST /${ACCOUNT_ID}/close`]: () => ({ challenge: account({ positions: [{ ...open, status: 'closing' }] }), position: { ...open, status: 'closing' } }),
      [`GET /${ACCOUNT_ID}`]: () => account({ status: 'funded', positions: [], progress: progress({ target: 0 }) }),
      [`GET /${ACCOUNT_ID}/history`]: () => ({ positions: [closed] }),
    }),
  )
  const r = await close(makeDeps(api).d, { position: open.id })
  assert.deepEqual(calls.find((c) => c.path.endsWith('/close'))?.body, { positionId: open.id })
  assert.equal(r.passed, true)
  assert.equal(r.accountStatus, 'funded')
  assert.equal(r.position.status, 'closed')
  assert.equal(r.position.pnlUsd, 500)
  assert.match(r.summary.join('\n'), /Passed: the assessment reached its target/)
})
