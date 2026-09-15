// `mm monfunded buy`: pays an assessment's fee to the MonFunded contract in USDC, AUSD or MON through
// MetaMask, then registers the mined entry with MonFunded. Everything that could waste the fee is
// checked before anything is signed: the session is this wallet's (the entry must be registered
// to the wallet that paid), no assessment is running (one at a time), the contract is deployed,
// charges exactly the listed fee and takes the two known coins, and the wallet holds the coin and
// gas. `--entry-tx` registers an entry already paid, without paying again.
import { AUSD, ENTRY_ATTEMPTS, MON_RESERVE_WEI, USDC } from './constants.ts'
import { approveCall, enterCall, enterWithMonCall, usd6, type Call } from './chain.ts'
import { CHAIN_LABEL, signIn, type Deps, type Plan } from './context.ts'
import { PluginError } from './errors.ts'
import { coin, mon, pct, planName, txUrl, usd } from './format.ts'
import { quoteMonFee } from './kuru.ts'
import type { Hex, PayWith, Risk, Tier } from './types.ts'
import { accountView } from './views.ts'

export type BuyInput = { size: number; risk: Risk; pay: PayWith; entryTx?: Hex }

const sizeFlag = (size: number) => (size % 1000 === 0 ? `${size / 1000}k` : String(size))
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const NEXT = 'Nothing was signed or paid. Run the same command again with --yes to sign and pay.'

type Step = { call: Call; summary: string; step: string }

export async function buy(d: Deps, input: BuyInput) {
  signIn(d)
  const config = await d.api.config()
  const contract = config.contract
  if (!contract) throw new PluginError('ENTRIES_CLOSED', 'Entries open once the MonFunded contract is deployed on Monad. It isn’t yet, so there is nothing to pay.', 'Run `mm monfunded status` later: it says when entries are open.')
  const tier = config.tiers.find((t) => t.risk === input.risk && t.size === input.size && t.enabled !== false)
  if (!tier) {
    const sizes = config.tiers.filter((t) => t.risk === input.risk && t.enabled !== false).map((t) => sizeFlag(t.size))
    throw new PluginError('UNKNOWN_PLAN', `MonFunded sells no ${input.risk} plan of $${input.size.toLocaleString('en-US')}.`, sizes.length ? `On sale at ${input.risk} risk: --size ${sizes.join(', ')}.` : 'Run `mm monfunded status` to see the plans on sale.')
  }
  const me = await d.api.me()
  const running = me.active.find((c) => c.status === 'assessment')
  if (running) throw new PluginError('ALREADY_ACTIVE', `This wallet already has an assessment running (${running.id}), and MonFunded allows one at a time. Nothing was paid.`, 'Pass or fail it first; `mm monfunded status` shows its progress.')
  const again = `mm monfunded buy --size ${sizeFlag(tier.size)} --risk ${tier.risk}`
  if (input.entryTx) return register(d, tier, input.entryTx, again)

  // The contract must charge what MonFunded lists, in the coins MonFunded names.
  const fee = usd6(tier.feeUsd)
  const [onchainFee, coins] = await Promise.all([d.reader.tierFee(contract, tier.index), d.reader.coins(contract)])
  if (!same(coins.usdc, USDC) || !same(coins.ausd, AUSD)) throw new PluginError('BAD_CONTRACT', `The contract ${contract} does not take MonFunded’s USDC and AUSD, so nothing was paid.`, 'If MONFUNDED_API_URL is set, check it points at MonFunded.')
  if (onchainFee !== fee) throw new PluginError('FEE_MISMATCH', `The contract charges ${usd(Number(onchainFee) / 1e6)} for this plan but MonFunded lists ${usd(tier.feeUsd)}, so nothing was paid.`, 'Tell MonFunded on Telegram (https://t.me/monfunded); try again once they match.')

  const name = planName(tier)
  const steps: Step[] = []
  let amount: string
  if (input.pay === 'MON') {
    const market = config.monMarket
    if (!market) throw new PluginError('MON_UNAVAILABLE', 'MonFunded doesn’t know Kuru’s MON_USDC book right now, so the fee can’t be paid in MON.', 'Pay with --pay usdc or --pay ausd, or try again in a minute.')
    const quote = await quoteMonFee(d.kuru, tier.feeUsd, market)
    const balance = await d.reader.nativeBalance(d.wallet)
    if (balance < quote.monWei + MON_RESERVE_WEI) throw new PluginError('INSUFFICIENT_FUNDS', `Paying ${mon(quote.monWei)} needs ${mon(quote.monWei + MON_RESERVE_WEI)} in the wallet (Monad keeps 10 MON in every account), and it holds ${mon(balance)}.`, 'Add MON with `mm wallet add-fund`, or pay with --pay usdc or --pay ausd.')
    amount = `${mon(quote.monWei)} (the ${usd(tier.feeUsd)} fee at Kuru’s best bid of ${quote.bestBid} USDC per MON, plus a 0.5 % buffer that stays in the reserve)`
    steps.push({
      call: enterWithMonCall(contract, tier.index, market, fee, quote.monWei),
      summary: `MonFunded: pay the ${name} assessment with ${mon(quote.monWei)}`,
      step: `enterWithMon(${tier.index}, ${market}, ${fee}) on ${contract}, sending ${mon(quote.monWei)}: the contract sells it on Kuru and needs at least ${coin(tier.feeUsd, 'USDC')} back, or the whole transaction reverts.`,
    })
  } else {
    const symbol = input.pay
    const token = symbol === 'AUSD' ? AUSD : USDC
    const [balance, allowance, gas] = await Promise.all([d.reader.tokenBalance(token, d.wallet), d.reader.allowance(token, d.wallet, contract), d.reader.nativeBalance(d.wallet)])
    if (balance < fee) throw new PluginError('INSUFFICIENT_FUNDS', `The fee is ${coin(tier.feeUsd, symbol)} and the wallet holds ${coin(Number(balance) / 1e6, symbol)}.`, `Add ${symbol} with \`mm wallet add-fund\`, or pay with another coin.`)
    if (gas === 0n) throw new PluginError('NO_GAS', 'The wallet has no MON to pay gas on Monad.', 'Add a little MON with `mm wallet add-fund`.')
    amount = coin(tier.feeUsd, symbol)
    if (allowance < fee) steps.push({ call: approveCall(token, contract, fee), summary: `MonFunded: let the contract take the ${amount} fee`, step: `approve(${contract}, ${fee}) on ${symbol} (${token}): lets the contract take exactly the fee, nothing more.` })
    steps.push({ call: enterCall(contract, tier.index, symbol), summary: `MonFunded: pay ${amount} for the ${name} assessment`, step: `${symbol === 'AUSD' ? 'enterWithAusd' : 'enter'}(${tier.index}) on ${contract}: moves ${amount} into the contract’s ${symbol} reserve and starts the account.` })
  }
  const plan: Plan = {
    action: `Buy the ${name} assessment (plan ${tier.id})`,
    amount,
    from: d.wallet,
    to: `the MonFunded contract ${contract}`,
    contract,
    chain: CHAIN_LABEL,
    steps: steps.map((s) => s.step),
    notes: [
      `Rules: close positions at ${pct(tier.rules.profitTargetPct)} profit to pass; losing ${pct(tier.rules.dailyLossPct)} in a day or ${pct(tier.rules.maxDrawdownPct)} in total fails the account.`,
      'The fee is not refundable once the account is active.',
    ],
  }
  if (!(await d.confirm(plan))) return { done: false as const, plan, next: NEXT, summary: [NEXT] }
  const signer = await d.signer()
  let entryTx: Hex | undefined
  for (const s of steps) entryTx = await signer.send(s.call, s.summary)
  return { ...(await register(d, tier, entryTx as Hex, again)), plan }
}

// Registers a mined entry with MonFunded and returns the new account. The server reads the
// receipt from its own RPC, which can trail the wallet's by a block or two: an entry it can't
// verify yet is retried. Any failure after paying says how to register without paying again.
async function register(d: Deps, tier: Tier, entryTx: Hex, again: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const account = await d.api.enter(tier.id, entryTx)
      const view = accountView(account, [tier], {}, d.now())
      return { done: true as const, entryTx, explorer: txUrl(entryTx), account: view, summary: [`Paid in ${txUrl(entryTx)}.`, ...view.summary] }
    } catch (e) {
      if (e instanceof PluginError && e.code === 'ENTRY_NOT_VERIFIED' && attempt < ENTRY_ATTEMPTS) {
        await d.sleep(2_000)
        continue
      }
      const why = e instanceof Error ? e.message : String(e)
      throw new PluginError(e instanceof PluginError ? e.code : 'REGISTER_FAILED', `${why} The entry is ${entryTx}.`, `Register it without paying again: ${again} --entry-tx ${entryTx}`)
    }
  }
}
