// Stand-ins for MonFunded's API, Monad and MetaMask's executor, so every flow runs in-process. The
// wallet is a throwaway key made per run; nothing reaches a network.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, keccak256, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Api, type ApiOptions, type Fetch } from '../src/lib/api.ts'
import type { ChainReader } from '../src/lib/chain.ts'
import { AUSD, KURU_ROUTER, USDC } from '../src/lib/constants.ts'
import type { Deps, Plan } from '../src/lib/context.ts'
import { SessionStore } from '../src/lib/session.ts'
import { executorSigner, type Executor, type ExecutorRequest } from '../src/lib/signer.ts'
import type { Address, Challenge, ChallengeConfig, Prices, RuleProgress, Rules, Tier } from '../src/lib/types.ts'

export const BASE = 'https://monfunded.com'
export const CONTRACT = getAddress('0x00000000000000000000000000000000000000c0')
export const MON_MARKET = getAddress('0x065c9d28e428a0db40191a54d33d5b7c71a9c394')
export const T0 = Date.UTC(2026, 8, 15, 12)
export const wallet = privateKeyToAccount(generatePrivateKey())
export const COOKIE = 'c0'.repeat(32)
export const ACCOUNT_ID = `0x${'a1'.repeat(32)}`

// The plans' caps by category (src/lib/limits.ts): crypto above every Perpl market's own maximum.
const LEVERAGE = { crypto: 100, forex: 30, metal: 20, index: 20, energy: 10, baseMetal: 10 }
const rules = (risk: 'tight' | 'medium', size: number): Rules =>
  risk === 'tight' ? { size, dailyLossPct: 3, maxDrawdownPct: 3, profitTargetPct: 9, leverage: LEVERAGE } : { size, dailyLossPct: 4, maxDrawdownPct: 7, profitTargetPct: 10, leverage: LEVERAGE }

export const TIERS: Tier[] = [
  { id: 'plan-5000', index: 0, size: 5000, feeUsd: 30, rules: rules('tight', 5000) },
  { id: 'plan-10000', index: 8, size: 10000, feeUsd: 100, rules: rules('medium', 10000) },
]

export const config = (over: Partial<ChallengeConfig> = {}): ChallengeConfig => ({ tiers: TIERS, profitSplitPct: 80, minWithdrawUsd: 10, contract: CONTRACT, usdc: USDC, ausd: AUSD, monMarket: MON_MARKET, reserveUsd: 1000, reserves: { USDC: 800, AUSD: 200 }, ...over })

export const progress = (over: Partial<RuleProgress> = {}): RuleProgress => ({ equity: 5000, balance: 5000, dailyPnl: 0, dailyLimit: 150, drawdownRoom: 150, drawdownFloor: 4850, profit: 0, target: 450, withdrawable: 0, withdrawablePaid: 0, ...over })

export const account = (over: Partial<Challenge> = {}): Challenge => ({
  id: ACCOUNT_ID,
  trader: wallet.address,
  tier: 'plan-5000',
  status: 'assessment',
  startedAt: T0 - 3_600_000,
  balance: 5000,
  rules: rules('tight', 5000),
  positions: [],
  progress: progress(),
  trades: 0,
  withdrawals: [],
  entryTx: `0x${'e0'.repeat(32)}`,
  ...over,
})

export const PRICES: Prices = {
  'perpl:BTC': { price: 60_000, bid: 59_999, ask: 60_001, updatedAt: T0, tradable: true, maxLeverage: 15 },
  'perpl:LIT': { price: 1, bid: 0.999, ask: 1.001, updatedAt: T0, tradable: true, maxLeverage: 3 },
  'perpl:ZEC': { price: 30, updatedAt: T0, tradable: false, maxLeverage: 10 },
  // A forex pair of MonFunded liquidity: its mid, the feed's bid and ask, its category's cap.
  'fx:USDJPY': { price: 155.106, bid: 155.104, ask: 155.108, updatedAt: T0, tradable: true, maxLeverage: 30 },
}

// ---- the API: 'METHOD /path' (under /challenge) → a handler; a plain value answers 200 ----

export type Reply = { reply: true; status: number; body: unknown; headers?: Record<string, string> }
export const reply = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({ reply: true, status, body, headers })
export type Call = { method: string; path: string; body: Record<string, unknown> | undefined; cookie?: string; headers: Record<string, string> }
type Handler = (body: Record<string, unknown> | undefined, call: Call) => unknown

// A Response stand-in: a real Headers object (so set-cookie survives, as it does from a server).
export function response(status: number, text: string, headers: Record<string, string> = {}): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json', ...headers }), text: async () => text, json: async () => JSON.parse(text) } as unknown as Response
}

// `options` default to a plugin released after the deployment: CONTRACT is the pinned contract.
export function fakeApi(routes: Record<string, Handler>, options: ApiOptions = { pinnedContract: CONTRACT }) {
  const calls: Call[] = []
  const fetchFn: Fetch = async (url, init) => {
    const headers = { ...(init.headers as Record<string, string>) }
    const call: Call = {
      method: init.method ?? 'GET',
      path: new URL(url).pathname.replace(/^\/challenge/, ''),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      // By the server's own name for it, whole: any other name reads as no session.
      cookie: /^__Host-monfunded_session=([0-9a-f]{64})$/.exec(headers.cookie ?? '')?.[1],
      headers,
    }
    calls.push(call)
    const handler = routes[`${call.method} ${call.path}`]
    const out = handler ? await handler(call.body, call) : reply(404, { error: 'notFound' })
    const r = (out as Reply)?.reply ? (out as Reply) : reply(200, out)
    return response(r.status, typeof r.body === 'string' ? r.body : JSON.stringify(r.body), r.headers)
  }
  return { api: new Api(BASE, fetchFn, undefined, options), calls, fetch: fetchFn }
}

// ---- Monad ----

// `swapOut`: what the router's swap of the fee's MON produces (6-decimal USDC); by default the MON at
// 0.25 USDC each, the price of the tests' Kuru book. 'down' stands for a chain that can't be asked.
// The latest block's time in the tests.
export const CHAIN_TIME = 1_790_000_000n
export function fakeChain(over: Partial<{ usdc: bigint; ausd: bigint; mon: bigint; allowance: bigint; fee: bigint; coins: { usdc: Address; ausd: Address }; paid: boolean; reserve: bigint; swapOut: bigint | 'down'; router: Address; time: bigint | 'down' }> = {}) {
  const state: { usdc: bigint; ausd: bigint; mon: bigint; allowance: bigint; fee: bigint; coins: { usdc: Address; ausd: Address }; paid: boolean; reserve: bigint; swapOut?: bigint | 'down'; router?: Address; time?: bigint | 'down' } = { usdc: 100_000_000n, ausd: 100_000_000n, mon: 1_000n * 10n ** 18n, allowance: 0n, fee: 30_000_000n, coins: { usdc: USDC as Address, ausd: AUSD as Address }, paid: false, reserve: 800_000_000n, ...over }
  const receipts = new Map<string, { from: Address; success: boolean }>()
  const reader: ChainReader = {
    tokenBalance: async (token, owner) => (owner === CONTRACT ? state.reserve : token === AUSD ? state.ausd : state.usdc),
    allowance: async () => state.allowance,
    nativeBalance: async () => state.mon,
    tierFee: async () => state.fee,
    router: async () => state.router ?? KURU_ROUTER,
    chainTime: async () => {
      if (state.time === 'down') throw new Error('no block')
      return state.time ?? CHAIN_TIME
    },
    simulateMonSwap: async (_trader, _market, wei) => {
      if (state.swapOut === 'down') throw new Error('rpc down')
      return state.swapOut ?? (wei * 250_000n) / 10n ** 18n
    },
    coins: async () => state.coins,
    isPaid: async () => state.paid,
    receipt: async (hash) => receipts.get(hash) ?? { from: wallet.address, success: true },
  }
  return { reader, state, receipts }
}

// ---- MetaMask's executor: signs with the throwaway key, "sends" by making up a hash ----

export function fakeExecutor() {
  const requests: ExecutorRequest[] = []
  let sent = 0
  const exec: Executor = async (request) => {
    requests.push(request)
    if (request.kind === 'message') return { kind: 'signature', status: 'CONFIRMED', signature: await wallet.signMessage({ message: request.message }) }
    return { kind: 'transaction', status: 'CONFIRMED', hash: keccak256(toHex(`tx ${++sent}`)) }
  }
  return { exec, requests }
}

// Everything a flow needs, signed in (unless told) as the throwaway wallet; `sleep` moves the clock.
export function makeDeps(api: Api, opts: { chain?: ReturnType<typeof fakeChain>; executor?: ReturnType<typeof fakeExecutor>; yes?: boolean; kuru?: Fetch; signedIn?: boolean } = {}) {
  const chain = opts.chain ?? fakeChain()
  const executor = opts.executor ?? fakeExecutor()
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'monfunded-agent-test-')))
  const clock = { now: T0 }
  const plans: Plan[] = []
  if (opts.signedIn !== false) store.save(BASE, { address: wallet.address, cookie: COOKIE, expiresAt: T0 + 86_400_000 })
  const d: Deps = {
    api,
    store,
    wallet: wallet.address,
    reader: chain.reader,
    kuru:
      opts.kuru ??
      (async () => {
        throw new Error('no Kuru in this test')
      }),
    signer: async () => executorSigner(executor.exec, chain.reader, wallet.address),
    confirm: async (plan) => {
      plans.push(plan)
      return opts.yes ?? false
    },
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms
    },
  }
  return { d, chain, executor, store, clock, plans }
}
