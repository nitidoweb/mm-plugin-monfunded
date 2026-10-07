// What every flow runs with: the API, the saved session, the active wallet, Monad reads, MetaMask's
// signer (asked for only once a plan is confirmed) and the clock. src/host.ts builds it from mm's
// command context; the tests build it from stand-ins.
import type { Api, Fetch } from './api.ts'
import type { Gate } from './chancela.ts'
import type { ChainReader } from './chain.ts'
import { PluginError } from './errors.ts'
import type { Session, SessionStore } from './session.ts'
import type { Signer } from './signer.ts'
import type { Address, Challenge, Me } from './types.ts'

export const CHAIN_LABEL = 'Monad (chain 143)'

// Everything a money-moving command shows before it signs or asks MonFunded to pay: what, how
// much in which coin, from where, to where, the contract, and each transaction in order.
export type Plan = {
  action: string
  amount: string
  from: string
  to: string
  contract: Address | null
  chain: string
  steps: string[]
  notes: string[]
}

// A plan as lines for the terminal (mm prints them above its confirmation prompt).
export function planLines(plan: Plan): string[] {
  return [
    plan.action,
    `  Amount:   ${plan.amount}`,
    `  From:     ${plan.from}`,
    `  To:       ${plan.to}`,
    `  Contract: ${plan.contract ?? 'none named by MonFunded right now'}`,
    `  Chain:    ${plan.chain}`,
    ...plan.steps.map((s, i) => `  Step ${i + 1}:   ${s}`),
    ...plan.notes.map((n) => `  Note:     ${n}`),
  ]
}

export type Deps = {
  api: Api
  store: SessionStore
  // The active MetaMask Agent Wallet address (mm's selected EVM wallet).
  wallet: Address
  reader: ChainReader
  // For Kuru's market data (the MON price of a fee).
  kuru: Fetch
  signer: () => Promise<Signer>
  // Whether to go ahead with a plan: --yes, or a yes at mm's interactive prompt.
  confirm: (plan: Plan) => Promise<boolean>
  // Chancela in front of every transfer (src/lib/chancela.ts), when the operator set it up: asked
  // after the plan is confirmed and before the wallet signs; it throws when the answer is not a
  // verified ALLOW.
  chancela?: Gate
  now: () => number
  sleep: (ms: number) => Promise<void>
}

// The saved session for this API if it belongs to the active wallet; later requests send it.
export function signIn(d: Pick<Deps, 'api' | 'store' | 'wallet' | 'now'>): Session {
  const s = d.store.get(d.api.base, d.now())
  if (!s) throw new PluginError('NOT_SIGNED_IN', `Not signed in to MonFunded (${d.api.base}) with this plugin, or the 7-day session expired.`, 'Run `mm monfunded login`.')
  if (s.address.toLowerCase() !== d.wallet.toLowerCase()) throw new PluginError('WRONG_WALLET', `Signed in to MonFunded as ${s.address}, but the active MetaMask wallet is ${d.wallet}.`, 'Run `mm monfunded login` to sign in with the active wallet, or switch back with `mm wallet select`.')
  d.api.useSession(s.cookie)
  return s
}

// The account a command acts on: the one named by --account, else the wallet's only running one
// (only funded one for `want: 'funded'`).
export function pickAccount(me: Me, id: string | undefined, want: 'active' | 'funded' = 'active'): Challenge {
  const pool = want === 'funded' ? me.active.filter((c) => c.status === 'funded') : me.active
  if (id) {
    const account = [...me.active, ...me.past].find((c) => c.id === id)
    if (!account) throw new PluginError('NOT_FOUND', `This wallet has no account ${id}.`, 'Run `mm monfunded status` to list your accounts.')
    if (!pool.includes(account)) throw want === 'funded' && account.status === 'assessment' ? new PluginError('NOT_FUNDED', `Account ${id} is still an assessment: only funded accounts withdraw.`, 'Pass the assessment first; `mm monfunded status` shows the profit target.') : new PluginError('ACCOUNT_ENDED', `Account ${id} has ended (failed).`, 'Run `mm monfunded status` to see why.')
    return account
  }
  if (pool.length === 1) return pool[0]
  if (!pool.length) {
    if (want === 'funded') throw new PluginError('NOT_FUNDED', 'This wallet has no funded account yet: only funded accounts withdraw.', 'Pass an assessment first; `mm monfunded status` shows the profit target.')
    throw new PluginError('NO_ACCOUNT', 'This wallet has no running MonFunded account.', 'Buy an assessment with `mm monfunded buy` (see `mm monfunded status` for the plans).')
  }
  throw new PluginError('WHICH_ACCOUNT', `This wallet has ${pool.length} running accounts: ${pool.map((c) => `${c.id} (${c.status})`).join(', ')}.`, 'Pass --account <id> to pick one.')
}
