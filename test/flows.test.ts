// buy and status against a stand-in API, Monad and MetaMask executor (login: login.test.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFunctionData, toHex, type Hex } from 'viem'
import { buy } from '../src/lib/buy.ts'
import { CHALLENGE_ABI, ERC20_ABI } from '../src/lib/chain.ts'
import { AUSD, USDC } from '../src/lib/constants.ts'
import { PluginError } from '../src/lib/errors.ts'
import type { ExecutorRequest } from '../src/lib/signer.ts'
import { status } from '../src/lib/status.ts'
import type { Position } from '../src/lib/types.ts'
import { account, BASE, config, CONTRACT, COOKIE, fakeApi, fakeChain, makeDeps, MON_MARKET, PRICES, progress, reply, response, T0, TIERS, wallet } from './fakes.ts'

const code = (c: string) => (e: unknown) => e instanceof PluginError && e.code === c
const txOf = (r: ExecutorRequest | undefined) => {
  assert.equal(r?.kind, 'transaction')
  return (r as Extract<ExecutorRequest, { kind: 'transaction' }>).transaction
}

// ---- buy ----

type Routes = Parameters<typeof fakeApi>[0]
const buyRoutes = (over: Routes = {}): Routes => ({
  'GET /config': () => config(),
  'GET /me': () => ({ address: wallet.address, active: [], past: [] }),
  'POST /enter': (b) => account({ tier: String(b?.tier), entryTx: b?.entryTx as Hex }),
  ...over,
})
const TIGHT_5K = { size: 5000, risk: 'tight', pay: 'USDC' } as const

test('buy refuses before paying: signed out, another wallet’s session, no contract, an assessment running, no such plan', async () => {
  const cases: [Routes, Parameters<typeof makeDeps>[1], Parameters<typeof buy>[1], string][] = [
    [buyRoutes(), { signedIn: false }, TIGHT_5K, 'NOT_SIGNED_IN'],
    [buyRoutes({ 'GET /config': () => config({ contract: null }) }), {}, TIGHT_5K, 'ENTRIES_CLOSED'],
    [buyRoutes({ 'GET /me': () => ({ address: wallet.address, active: [account()], past: [] }) }), {}, TIGHT_5K, 'ALREADY_ACTIVE'],
    [buyRoutes(), {}, { ...TIGHT_5K, size: 7000 }, 'UNKNOWN_PLAN'],
  ]
  for (const [routes, opts, input, expected] of cases) {
    const { api, calls } = fakeApi(routes)
    const { d, executor } = makeDeps(api, { ...opts, yes: true })
    await assert.rejects(buy(d, input), code(expected))
    assert.equal(executor.requests.length, 0, expected)
    assert.ok(!calls.some((c) => c.path === '/enter'), expected)
  }
  const { api } = fakeApi(buyRoutes())
  const other = makeDeps(api, { yes: true })
  other.store.save(BASE, { address: '0x0000000000000000000000000000000000000001', cookie: COOKIE, expiresAt: T0 + 1000 })
  await assert.rejects(buy(other.d, TIGHT_5K), code('WRONG_WALLET'))
})

test('a funded account doesn’t block a new assessment', async () => {
  const { api } = fakeApi(buyRoutes({ 'GET /me': () => ({ address: wallet.address, active: [account({ status: 'funded' })], past: [] }) }))
  const { d } = makeDeps(api)
  assert.equal((await buy(d, TIGHT_5K)).done, false)
})

test('without --yes, buy shows the payment and signs nothing', async () => {
  const { api, calls } = fakeApi(buyRoutes())
  const { d, executor, plans } = makeDeps(api)
  const r = await buy(d, TIGHT_5K)
  assert.equal(r.done, false)
  assert.equal(executor.requests.length, 0)
  assert.ok(!calls.some((c) => c.path === '/enter'))
  const [plan] = plans
  assert.equal(plan.amount, '30.00 USDC')
  assert.equal(plan.from, wallet.address)
  assert.equal(plan.contract, CONTRACT)
  assert.match(plan.to, new RegExp(CONTRACT))
  assert.equal(plan.chain, 'Monad (chain 143)')
  assert.equal(plan.steps.length, 2)
  assert.match(plan.steps[0], /^approve\(/)
  assert.match(plan.steps[1], /^enter\(0\)/)
})

test('buy --yes approves exactly the fee, enters, and registers the entry', async () => {
  const { api, calls } = fakeApi(buyRoutes())
  const { d, executor } = makeDeps(api, { yes: true })
  const r = await buy(d, TIGHT_5K)
  assert.equal(r.done, true)
  const approve = txOf(executor.requests[0])
  const enter = txOf(executor.requests[1])
  assert.equal(approve.to, USDC)
  assert.deepEqual(decodeFunctionData({ abi: ERC20_ABI, data: approve.data }), { functionName: 'approve', args: [CONTRACT, 30_000_000n] })
  assert.equal(enter.to, CONTRACT)
  assert.equal(enter.value, '0x0')
  assert.deepEqual(decodeFunctionData({ abi: CHALLENGE_ABI, data: enter.data }), { functionName: 'enter', args: [0] })
  const post = calls.find((c) => c.path === '/enter')
  assert.ok(r.done && 'entryTx' in r)
  assert.deepEqual(post?.body, { tier: 'tight-5000', entryTx: r.entryTx })
  assert.equal(post?.cookie, COOKIE)
})

test('an allowance in place skips the approval; AUSD pays through enterWithAusd', async () => {
  const { api } = fakeApi(buyRoutes())
  const one = makeDeps(api, { yes: true, chain: fakeChain({ allowance: 30_000_000n }) })
  await buy(one.d, TIGHT_5K)
  assert.equal(one.executor.requests.length, 1)
  const ausd = makeDeps(api, { yes: true, chain: fakeChain({ fee: 100_000_000n, ausd: 100_000_000n }) })
  await buy(ausd.d, { size: 10_000, risk: 'medium', pay: 'AUSD' })
  assert.equal(txOf(ausd.executor.requests[0]).to, AUSD)
  assert.deepEqual(decodeFunctionData({ abi: CHALLENGE_ABI, data: txOf(ausd.executor.requests[1]).data }), { functionName: 'enterWithAusd', args: [8] })
})

const kuru = async (url: string) =>
  url.includes('exchangeInfo')
    ? response(200, JSON.stringify({ symbols: [{ symbol: 'MON_USDC', marketAddress: MON_MARKET.toLowerCase(), sizePrecision: '10000000000', takerFeeBps: 0 }] }))
    : response(200, JSON.stringify({ bids: [[String(0.25e18), String(300 * 1e10)]] }))

test('MON: the quoted MON goes to enterWithMon with a floor from the swap simulated on chain, never under the fee, keeping Monad’s 10 MON', async () => {
  const { api } = fakeApi(buyRoutes())
  const { d, executor } = makeDeps(api, { yes: true, kuru })
  await buy(d, { ...TIGHT_5K, pay: 'MON' })
  const tx = txOf(executor.requests[0])
  assert.equal(executor.requests.length, 1)
  assert.equal(tx.value, toHex(120_600_000_000_000_000_000n))
  // 120.6 MON sells for 30.15 USDC; less 0.5 % is under the 30 fee, so the floor is the fee.
  assert.deepEqual(decodeFunctionData({ abi: CHALLENGE_ABI, data: tx.data }), { functionName: 'enterWithMon', args: [0, MON_MARKET, 30_000_000n] })
  // MON rose 1.5 % since the quote: the swap would produce 30.45; the floor keeps all but 0.5 % of it.
  const rose = makeDeps(api, { yes: true, kuru, chain: fakeChain({ swapOut: 30_450_000n }) })
  await buy(rose.d, { ...TIGHT_5K, pay: 'MON' })
  assert.deepEqual(decodeFunctionData({ abi: CHALLENGE_ABI, data: txOf(rose.executor.requests[0]).data }), { functionName: 'enterWithMon', args: [0, MON_MARKET, 30_297_750n] })
  // Kuru's API lied (the MON quoted is far more than the fee needs: it sells for 3,000 USDC), the swap
  // falls short of the fee, or the chain can't be asked: nothing is signed.
  for (const swapOut of [3_000_000_000n, 29_999_999n, 'down'] as const) {
    const bad = makeDeps(api, { yes: true, kuru, chain: fakeChain({ swapOut }) })
    await assert.rejects(buy(bad.d, { ...TIGHT_5K, pay: 'MON' }), code('MON_PRICE_UNCONFIRMED'))
    assert.equal(bad.executor.requests.length, 0, String(swapOut))
  }
  // The contract swaps on another router than the pinned one the plugin simulates on: nothing is signed.
  const otherRouter = makeDeps(api, { yes: true, kuru, chain: fakeChain({ router: '0x000000000000000000000000000000000000dEaD' }) })
  await assert.rejects(buy(otherRouter.d, { ...TIGHT_5K, pay: 'MON' }), code('BAD_CONTRACT'))
  assert.equal(otherRouter.executor.requests.length, 0)
  const poor = makeDeps(api, { yes: true, kuru, chain: fakeChain({ mon: 130n * 10n ** 18n }) })
  await assert.rejects(buy(poor.d, { ...TIGHT_5K, pay: 'MON' }), (e) => code('INSUFFICIENT_FUNDS')(e) && /10 MON/.test((e as Error).message))
  const noBook = fakeApi(buyRoutes({ 'GET /config': () => config({ monMarket: null }) }))
  await assert.rejects(buy(makeDeps(noBook.api, { yes: true, kuru }).d, { ...TIGHT_5K, pay: 'MON' }), code('MON_UNAVAILABLE'))
})

test('a plan being repriced (the contract’s fee isn’t the listed one, either way) is refused in every coin before anything is signed', async () => {
  const { api } = fakeApi(buyRoutes())
  for (const fee of [29_000_000n, 31_000_000n])
    for (const pay of ['USDC', 'AUSD', 'MON'] as const) {
      const { d, executor } = makeDeps(api, { yes: true, kuru, chain: fakeChain({ fee }) })
      await assert.rejects(buy(d, { ...TIGHT_5K, pay }), (e) => code('FEE_CHANGING')(e) && /being updated on the contract \(it charges \$\d+\.00; MonFunded lists \$30\.00\), so nothing was paid\./.test((e as Error).message) && /Try again in a minute/.test((e as PluginError).hint), `${pay} at ${fee}`)
      assert.equal(executor.requests.length, 0, `${pay} at ${fee}`)
    }
})

test('a repricing while the payment is shown, or between the approval and the entry, stops before the next signature', async () => {
  // The contract is repriced while the user reads the plan: nothing is signed.
  const one = makeDeps(fakeApi(buyRoutes()).api, { yes: true })
  const confirm = one.d.confirm
  one.d.confirm = async (plan) => {
    one.chain.state.fee = 35_000_000n
    return confirm(plan)
  }
  await assert.rejects(buy(one.d, TIGHT_5K), code('FEE_CHANGING'))
  assert.equal(one.executor.requests.length, 0)
  // The server's plan is repriced once the approval is sent (its third config read): the entry
  // never goes, and nothing is registered.
  let reads = 0
  const repriced = fakeApi(buyRoutes({ 'GET /config': () => (++reads >= 3 ? config({ tiers: TIERS.map((t) => (t.id === 'tight-5000' ? { ...t, feeUsd: 35 } : t)) }) : config()) }))
  const two = makeDeps(repriced.api, { yes: true })
  await assert.rejects(buy(two.d, TIGHT_5K), (e) => code('FEE_CHANGING')(e) && /MonFunded lists \$35\.00/.test((e as Error).message))
  assert.equal(two.executor.requests.length, 1, 'the approval only')
  assert.equal(txOf(two.executor.requests[0]).to, USDC)
  assert.ok(!repriced.calls.some((c) => c.path === '/enter'))
  // A plan paused meanwhile: no entry either.
  let seen = 0
  const paused = fakeApi(buyRoutes({ 'GET /config': () => (++seen >= 2 ? config({ tiers: TIERS.map((t) => ({ ...t, enabled: t.id !== 'tight-5000' })) }) : config()) }))
  const three = makeDeps(paused.api, { yes: true })
  await assert.rejects(buy(three.d, TIGHT_5K), code('ENTRIES_CLOSED'))
  assert.equal(three.executor.requests.length, 0)
})

test('buy refuses a contract that charges another fee or takes other coins, a short wallet, no gas', async () => {
  const { api } = fakeApi(buyRoutes())
  const cases: [Parameters<typeof fakeChain>[0], string][] = [
    [{ fee: 31_000_000n }, 'FEE_CHANGING'],
    [{ coins: { usdc: CONTRACT, ausd: AUSD } }, 'BAD_CONTRACT'],
    [{ usdc: 29_999_999n }, 'INSUFFICIENT_FUNDS'],
    [{ mon: 0n }, 'NO_GAS'],
  ]
  for (const [chain, expected] of cases) {
    const { d, executor } = makeDeps(api, { yes: true, chain: fakeChain(chain) })
    await assert.rejects(buy(d, TIGHT_5K), code(expected))
    assert.equal(executor.requests.length, 0, expected)
  }
})

test('an entry the server can’t see yet is retried; a failure after paying says how to register it', async () => {
  let tries = 0
  const slow = fakeApi(buyRoutes({ 'POST /enter': () => (++tries < 3 ? reply(400, { error: 'entryNotVerified' }) : account()) }))
  const one = makeDeps(slow.api, { yes: true })
  assert.equal((await buy(one.d, TIGHT_5K)).done, true)
  assert.equal(tries, 3)
  assert.equal(one.clock.now, T0 + 4_000)
  const never = fakeApi(buyRoutes({ 'POST /enter': () => reply(400, { error: 'entryNotVerified' }) }))
  await assert.rejects(buy(makeDeps(never.api, { yes: true }).d, TIGHT_5K), (e) => code('ENTRY_NOT_VERIFIED')(e) && /^Register it without paying again: mm monfunded buy --size 5k --risk tight --entry-tx 0x[0-9a-f]{64}$/.test((e as PluginError).hint))
})

test('an entry the server refuses for good (underpaid after a price change, too old) keeps its own hint, unretried', async () => {
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [{ error: 'entryUnderpaid', paidUsd: 30, feeUsd: 35 }, 'ENTRY_UNDERPAID', /paid \$30\.00; the plan costs \$35\.00/],
    [{ error: 'entryExpired', maxAgeHours: 72 }, 'ENTRY_EXPIRED', /72 hours/],
  ]
  for (const [body, expected, detail] of cases) {
    let tries = 0
    const { api } = fakeApi(
      buyRoutes({
        'POST /enter': () => {
          tries++
          return reply(400, body)
        },
      }),
    )
    const { d } = makeDeps(api, { yes: true })
    await assert.rejects(buy(d, TIGHT_5K), (e) => code(expected)(e) && detail.test((e as Error).message) && /The entry is 0x[0-9a-f]{64}\.$/.test((e as Error).message) && /support ticket/.test((e as PluginError).hint) && !/--entry-tx/.test((e as PluginError).hint))
    assert.equal(tries, 1, expected)
  }
})

test('--entry-tx registers an entry already paid, without paying again', async () => {
  const entryTx = `0x${'fe'.repeat(32)}` as Hex
  const { api, calls } = fakeApi(buyRoutes())
  const { d, executor } = makeDeps(api)
  assert.equal((await buy(d, { ...TIGHT_5K, entryTx })).done, true)
  assert.equal(executor.requests.length, 0)
  assert.deepEqual(calls.find((c) => c.path === '/enter')?.body, { tier: 'tight-5000', entryTx })
})

// ---- status ----

test('signed out, status still answers: the plans, whether entries are open, how to sign in', async () => {
  const { api } = fakeApi({ 'GET /config': () => config({ contract: null }) })
  const r = await status(makeDeps(api, { signedIn: false }).d)
  assert.equal(r.signedIn, false)
  assert.equal(r.entriesOpen, false)
  assert.deepEqual(
    r.plans.map((p) => p.id),
    ['tight-5000', 'medium-10000'],
  )
  assert.match(r.summary.join('\n'), /mm monfunded login/)
})

test('signed in, status reports each account’s rule meters, positions and withdrawals', async () => {
  const open: Position = { id: 'p000000000001', marketId: 'perpl:BTC', side: 'long', status: 'open', notional: 1000, leverage: 2, margin: 500, requestedAt: T0 - 60_000, entryPrice: 59_000, openedAt: T0 - 30_000 }
  const funded = account({
    id: `0x${'b2'.repeat(32)}`,
    status: 'funded',
    progress: progress({ equity: 5200, balance: 5200, profit: 200, target: 0, withdrawable: 200, withdrawablePaid: 160, dailyPnl: -20 }),
    withdrawals: [{ id: `0x${'c3'.repeat(32)}`, amountUsd: 50, paidUsd: 40, token: 'USDC', status: 'review', requestedAt: T0 }],
  })
  const { api, calls } = fakeApi({
    'GET /config': () => config(),
    'GET /me': () => ({ address: wallet.address, active: [account({ positions: [open], progress: progress({ profit: 45, dailyPnl: 16.95 }) }), funded], past: [account({ id: `0x${'d4'.repeat(32)}`, status: 'failed', reason: 'dailyLoss', endedAt: T0 - 1000 })] }),
    'GET /prices': () => PRICES,
  })
  const r = await status(makeDeps(api).d)
  assert.equal(r.signedIn, true)
  assert.ok(calls.filter((c) => c.path !== '/config').every((c) => c.cookie === COOKIE))
  assert.ok('accounts' in r)
  const [a, f] = r.accounts
  assert.deepEqual(a.profitTarget, { profitUsd: 45, targetUsd: 450, progressPct: 10 })
  assert.deepEqual(a.dailyLoss, { roomUsd: 166.95, limitUsd: 150, todayPnlUsd: 16.95 })
  assert.deepEqual(a.drawdown, { roomUsd: 150, floorUsd: 4850 })
  assert.equal(a.positions[0].pnlUsd, 16.95)
  assert.equal(a.positions[0].markPrice, 60_000)
  assert.equal(a.positions[0].closableFrom, new Date(T0 + 30_000).toISOString())
  assert.deepEqual(f.withdrawable, { amountUsd: 200, youReceiveUsd: 160 })
  assert.equal(f.withdrawals[0].state, 'review')
  assert.equal(r.pastAccounts[0].reason, 'dailyLoss')
  assert.match(r.summary.join('\n'), /Tight \$5,000 assessment/)
})

test('a session saved for another wallet reads as signed out', async () => {
  const { api } = fakeApi({ 'GET /config': () => config() })
  const x = makeDeps(api, { signedIn: false })
  x.store.save(BASE, { address: '0x0000000000000000000000000000000000000001', cookie: COOKIE, expiresAt: T0 + 1000 })
  const r = await status(x.d)
  assert.equal(r.signedIn, false)
  assert.match(r.summary[0], /not the active wallet/)
})
