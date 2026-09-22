// `mm monfunded withdraw` and `claim`: taking profit off a funded account, and collecting a payout
// from the contract yourself. A withdrawal pays the trader's share (80 %) in USDC or AUSD from the
// contract's reserve of that coin, always to the wallet that owns the account; MonFunded's
// operator sends it, or the trader claims it with the operator's signature. A wallet the screening
// flags is held for an admin's review first.
import { AUSD, PAYOUT_WAIT_MS, POLL_MS, USDC } from './constants.ts'
import { claimCall, usd6 } from './chain.ts'
import { CHAIN_LABEL, pickAccount, signIn, type Deps, type Plan } from './context.ts'
import { PluginError } from './errors.ts'
import { coin, txUrl, usd } from './format.ts'
import type { Hex, PayoutToken, Withdrawal } from './types.ts'
import { withdrawalView } from './views.ts'

export type WithdrawInput = { token: PayoutToken; account?: string }
export type ClaimInput = { withdrawal: Hex }

const other = (token: PayoutToken): PayoutToken => (token === 'USDC' ? 'AUSD' : 'USDC')

// Polls until the operator's payout lands or the withdrawal is held, for up to PAYOUT_WAIT_MS.
async function awaitPayout(d: Deps, accountId: string, first: Withdrawal): Promise<Withdrawal> {
  const deadline = d.now() + PAYOUT_WAIT_MS
  let w = first
  while (w.paidAt === undefined && w.status === undefined && d.now() < deadline) {
    await d.sleep(2 * POLL_MS)
    w = (await d.api.account(accountId)).withdrawals.find((x) => x.id === first.id) ?? w
  }
  return w
}

// A payout takes the whole cycle's profit at once (2026-09-21): no amount to give any more. The
// account must be flat (no live position) and not already waiting on a decision; `progress
// .withdrawable` already reads 0 for either (server/challenge-rules.mjs, computeProgress), so the
// one local check below (profit under the minimum) already covers both — `mm monfunded status`
// says which.
export async function withdraw(d: Deps, input: WithdrawInput) {
  signIn(d)
  const [me, config] = await Promise.all([d.api.me(), d.api.config()])
  const account = pickAccount(me, input.account, 'funded')
  const p = account.progress
  if (p.withdrawable < config.minWithdrawUsd) throw new PluginError('NOTHING_TO_WITHDRAW', `Account ${account.id} has ${usd(p.withdrawable)} of profit to take, under the ${usd(config.minWithdrawUsd)} minimum (an open position, or a payout already pending, also reads as nothing to take).`, 'Run `mm monfunded status` to see why: an open position, a payout already pending, or not enough profit yet.')
  const paid = p.withdrawablePaid
  const reserve = config.reserves[input.token]
  if (reserve !== null && reserve < paid) {
    const alt = config.reserves[other(input.token)]
    throw new PluginError('RESERVE_LOW', `The contract’s ${input.token} reserve (${usd(reserve)}) can’t cover this ${coin(paid, input.token)} payout right now.`, alt !== null && alt >= paid ? `Withdraw in ${other(input.token)} instead: --token ${other(input.token).toLowerCase()}.` : 'Try again later.')
  }
  const plan: Plan = {
    action: `Take all the profit off funded account ${account.id}`,
    amount: `${coin(paid, input.token)} to you (${config.profitSplitPct} % of ${usd(p.withdrawable)}); the account’s balance resets to its starting size at once`,
    from: `the MonFunded contract’s ${input.token} reserve${config.contract ? ` (${config.contract})` : ''}`,
    to: `your wallet ${d.wallet}: payouts only ever go to the wallet that owns the account`,
    contract: config.contract,
    chain: CHAIN_LABEL,
    steps: [`MonFunded records the payout, screens the wallet, and its operator sends ${coin(paid, input.token)} with payout() on the contract.`],
    notes: [
      'Your wallet signs nothing and pays no gas for this.',
      'A payout is always the whole profit: there is no amount to choose.',
      'The account pauses until this payout is released or declined; released, it trades again from its starting balance.',
      'A wallet the screening flags is held for an admin’s review before anything is paid.',
      'If the payout has not arrived, collect it yourself: `mm monfunded claim --withdrawal <id>`.',
      'A payout can’t be undone.',
    ],
  }
  if (!(await d.confirm(plan))) {
    const next = 'Nothing was requested. Run the same command again with --yes to withdraw.'
    return { done: false as const, plan, next, summary: [next] }
  }
  const { withdrawal } = await d.api.withdraw(account.id, input.token)
  const view = withdrawalView(await awaitPayout(d, account.id, withdrawal))
  return { done: true as const, plan, account: account.id, withdrawal: view, summary: [view.summary] }
}

export async function claim(d: Deps, input: ClaimInput) {
  signIn(d)
  const [me, config] = await Promise.all([d.api.me(), d.api.config()])
  const found = [...me.active, ...me.past].flatMap((c) => c.withdrawals.map((w) => ({ c, w }))).find((x) => x.w.id === input.withdrawal)
  if (!found) throw new PluginError('NOT_FOUND', `This wallet has no withdrawal ${input.withdrawal}.`, 'Run `mm monfunded status` to list your withdrawals.')
  const { c, w } = found
  if (w.paidAt !== undefined) {
    const view = withdrawalView(w)
    return { done: true as const, alreadyPaid: true, withdrawal: view, summary: [view.summary] }
  }
  if (w.status === 'review') throw new PluginError('UNDER_REVIEW', 'This payout is held for review: MonFunded screens payout wallets, and an admin decides on this one before it can be paid or claimed.', 'Nothing to do but wait; `mm monfunded status` shows when it is approved.')
  if (w.status === 'rejected') throw new PluginError('WITHDRAWAL_REJECTED', 'An admin declined this withdrawal after review: it will never be paid.', 'Ask MonFunded on Telegram (https://t.me/monfunded) if you think this is a mistake.')
  const contract = config.contract
  if (!contract) throw new PluginError('NO_CONTRACT', 'MonFunded has no contract on Monad yet, so there is nothing to claim from.', 'Try again once `mm monfunded status` says entries are open.')
  if (c.trader.toLowerCase() !== d.wallet.toLowerCase()) throw new PluginError('WRONG_WALLET', `Withdrawal ${w.id} belongs to ${c.trader}; the contract pays only that wallet.`, 'Switch to it with `mm wallet select` and sign in again.')
  const proof = await d.api.claimProof(c.id, w.id)
  if (proof.token !== w.token) throw new PluginError('BAD_PROOF', 'The claim proof names a different coin from the withdrawal.', 'Nothing was signed. Try again in a minute.')
  const id = w.id as Hex
  if (await d.reader.isPaid(contract, id)) return { done: true as const, alreadyPaid: true, withdrawal: withdrawalView(w), summary: ['The contract has already paid this withdrawal (the operator’s payout landed); MonFunded records it within a minute.'] }
  const token = proof.token === 'AUSD' ? AUSD : USDC
  const amount = usd6(w.paidUsd)
  const [reserve, gas] = await Promise.all([d.reader.tokenBalance(token, contract), d.reader.nativeBalance(d.wallet)])
  if (reserve < amount) throw new PluginError('RESERVE_LOW', `The contract’s ${proof.token} reserve holds ${coin(Number(reserve) / 1e6, proof.token)}, less than this ${coin(w.paidUsd, proof.token)} payout, so a claim would revert.`, 'Wait for MonFunded to top up the reserve; its operator retries the payout every minute.')
  if (gas === 0n) throw new PluginError('NO_GAS', 'The wallet has no MON to pay gas for the claim.', 'Add a little MON with `mm wallet add-fund`.')
  const plan: Plan = {
    action: `Claim withdrawal ${w.id} from the MonFunded contract`,
    amount: coin(w.paidUsd, proof.token),
    from: `the MonFunded contract’s ${proof.token} reserve (${contract})`,
    to: `your wallet ${d.wallet}`,
    contract,
    chain: CHAIN_LABEL,
    steps: [`claim(${w.id}, ${token}, ${amount}, ${proof.logRoot}, <MonFunded operator’s signature>) on ${contract}: pays ${coin(w.paidUsd, proof.token)} to the wallet that sends it, once.`],
    notes: ['Your wallet pays the gas in MON.', 'The operator’s signature names this wallet, this coin and this amount: the contract refuses any other.'],
  }
  if (!(await d.confirm(plan))) {
    const next = 'Nothing was signed. Run the same command again with --yes to sign and claim.'
    return { done: false as const, plan, next, summary: [next] }
  }
  const signer = await d.signer()
  const tx = await signer.send(claimCall(contract, id, token, amount, proof.logRoot, proof.signature), `MonFunded: claim your ${coin(w.paidUsd, proof.token)} payout`)
  return { done: true as const, alreadyPaid: false, plan, tx, explorer: txUrl(tx), summary: [`Claimed ${coin(w.paidUsd, proof.token)} in ${txUrl(tx)}.`] }
}
