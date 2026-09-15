// withdraw and claim against a stand-in API, Monad and MetaMask executor.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFunctionData } from 'viem'
import { CHALLENGE_ABI } from '../src/lib/chain.ts'
import { USDC } from '../src/lib/constants.ts'
import { PluginError } from '../src/lib/errors.ts'
import { claim, withdraw } from '../src/lib/payout.ts'
import type { ExecutorRequest } from '../src/lib/signer.ts'
import type { Challenge, Hex, Withdrawal } from '../src/lib/types.ts'
import { account, ACCOUNT_ID, config, CONTRACT, fakeApi, fakeChain, makeDeps, progress, T0, wallet } from './fakes.ts'

const code = (c: string) => (e: unknown) => e instanceof PluginError && e.code === c
type Routes = Parameters<typeof fakeApi>[0]
const WID = `0x${'c3'.repeat(32)}` as Hex
const funded = (over: Partial<Challenge> = {}) => account({ status: 'funded', progress: progress({ equity: 5300, balance: 5300, profit: 300, target: 0, withdrawable: 300, withdrawablePaid: 240 }), ...over })
const me = (...active: Challenge[]) => () => ({ address: wallet.address, active, past: [] })

test('withdraw shows the payout first (80 %, the coin, where it goes) and asks for nothing', async () => {
  const { api, calls } = fakeApi({ 'GET /me': me(funded()), 'GET /config': () => config() })
  const { d, plans } = makeDeps(api)
  const r = await withdraw(d, { amount: 100, token: 'USDC' })
  assert.equal(r.done, false)
  assert.match(plans[0].amount, /^80\.00 USDC to you \(80 % of \$100\.00\)/)
  assert.match(plans[0].to, new RegExp(wallet.address))
  assert.equal(plans[0].contract, CONTRACT)
  assert.ok(!calls.some((c) => c.path.endsWith('/withdraw')))
})

test('withdraw --yes asks MonFunded and waits for the operator’s payout', async () => {
  const w: Withdrawal = { id: WID, amountUsd: 100, paidUsd: 80, token: 'AUSD', requestedAt: T0 }
  let reads = 0
  const { api, calls } = fakeApi({
    'GET /me': me(funded()),
    'GET /config': () => config(),
    [`POST /${ACCOUNT_ID}/withdraw`]: () => ({ challenge: funded({ withdrawals: [w] }), withdrawal: w }),
    [`GET /${ACCOUNT_ID}`]: () => funded({ withdrawals: [++reads < 2 ? w : { ...w, paidAt: T0 + 3000, tx: `0x${'d4'.repeat(32)}` }] }),
  })
  const r = await withdraw(makeDeps(api, { yes: true }).d, { amount: 100, token: 'AUSD' })
  assert.deepEqual(calls.find((c) => c.path.endsWith('/withdraw'))?.body, { amountUsd: 100, token: 'AUSD' })
  assert.ok(r.done && 'withdrawal' in r)
  assert.equal(r.withdrawal.state, 'paid')
  assert.equal(r.withdrawal.explorer, `https://monadscan.com/tx/0x${'d4'.repeat(32)}`)
})

test('withdraw refuses: no funded account, over the withdrawable profit, under $10, a short reserve', async () => {
  const cases: [Routes, number, string][] = [
    [{ 'GET /me': me(account()), 'GET /config': () => config() }, 100, 'NOT_FUNDED'],
    [{ 'GET /me': me(funded()), 'GET /config': () => config() }, 301, 'NOTHING_TO_WITHDRAW'],
    [{ 'GET /me': me(funded()), 'GET /config': () => config() }, 5, 'INVALID_INPUT'],
    [{ 'GET /me': me(funded()), 'GET /config': () => config({ reserves: { USDC: 50, AUSD: 900 } }) }, 100, 'RESERVE_LOW'],
  ]
  for (const [routes, amount, expected] of cases) {
    const { api, calls } = fakeApi(routes)
    await assert.rejects(withdraw(makeDeps(api, { yes: true }).d, { amount, token: 'USDC' }), (e) => code(expected)(e) && (expected !== 'RESERVE_LOW' || /--token ausd/.test((e as PluginError).hint)))
    assert.ok(!calls.some((c) => c.path.endsWith('/withdraw')), expected)
  }
})

const proofPath = `GET /${ACCOUNT_ID}/withdrawals/${WID}/claim`
const PROOF = { signature: `0x${'11'.repeat(65)}`, logRoot: `0x${'22'.repeat(32)}`, token: 'USDC' }
const unpaid: Withdrawal = { id: WID, amountUsd: 100, paidUsd: 80, token: 'USDC', requestedAt: T0 }

test('claim explains a payout held for review or declined, and reports one already paid', async () => {
  for (const [w, expected] of [
    [{ ...unpaid, status: 'review' }, 'UNDER_REVIEW'],
    [{ ...unpaid, status: 'rejected' }, 'WITHDRAWAL_REJECTED'],
  ] as const) {
    const { api, calls } = fakeApi({ 'GET /me': me(funded({ withdrawals: [w] })), 'GET /config': () => config() })
    await assert.rejects(claim(makeDeps(api, { yes: true }).d, { withdrawal: WID }), code(expected))
    assert.ok(!calls.some((c) => c.path.endsWith('/claim')))
  }
  const { api } = fakeApi({ 'GET /me': me(funded({ withdrawals: [{ ...unpaid, paidAt: T0, tx: `0x${'d4'.repeat(32)}` }] })), 'GET /config': () => config() })
  const r = await claim(makeDeps(api, { yes: true }).d, { withdrawal: WID })
  assert.equal(r.done && r.alreadyPaid, true)
})

test('claim shows the claim first, then sends claim() with the operator’s proof, paid to this wallet', async () => {
  const routes: Routes = { 'GET /me': me(funded({ withdrawals: [unpaid] })), 'GET /config': () => config(), [proofPath]: () => PROOF }
  const preview = makeDeps(fakeApi(routes).api)
  const shown = await claim(preview.d, { withdrawal: WID })
  assert.equal(shown.done, false)
  assert.equal(preview.plans[0].amount, '80.00 USDC')
  assert.ok(!JSON.stringify(preview.plans[0]).includes('11'.repeat(65)), 'the signature is not printed')
  assert.equal(preview.executor.requests.length, 0)
  const { d, executor } = makeDeps(fakeApi(routes).api, { yes: true })
  const r = await claim(d, { withdrawal: WID })
  const request = executor.requests[0] as Extract<ExecutorRequest, { kind: 'transaction' }>
  assert.equal(request.transaction.to, CONTRACT)
  assert.deepEqual(decodeFunctionData({ abi: CHALLENGE_ABI, data: request.transaction.data }), { functionName: 'claim', args: [WID, USDC, 80_000_000n, PROOF.logRoot, PROOF.signature] })
  assert.match((r as { tx?: string }).tx ?? '', /^0x[0-9a-f]{64}$/)
})

test('claim checks the chain first: already paid there, or a reserve too small to pay', async () => {
  const routes: Routes = { 'GET /me': me(funded({ withdrawals: [unpaid] })), 'GET /config': () => config(), [proofPath]: () => PROOF }
  const paid = makeDeps(fakeApi(routes).api, { yes: true, chain: fakeChain({ paid: true }) })
  assert.equal((await claim(paid.d, { withdrawal: WID })).done, true)
  assert.equal(paid.executor.requests.length, 0)
  const short = makeDeps(fakeApi(routes).api, { yes: true, chain: fakeChain({ reserve: 79_999_999n }) })
  await assert.rejects(claim(short.d, { withdrawal: WID }), code('RESERVE_LOW'))
  assert.equal(short.executor.requests.length, 0)
})
