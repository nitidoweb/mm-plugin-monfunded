// `mm monfunded buy`: pays an assessment's fee to the MonFunded contract in USDC, AUSD or MON through
// MetaMask, then registers the mined entry with MonFunded. Everything that could waste the fee is
// checked before anything is signed: the session is this wallet's (the entry must be registered
// to the wallet that paid), the wallet is under MonFunded's limits (five assessments at once,
// $400,000 of funded size), entries are open, the contract charges exactly the listed fee and takes
// the two known coins, and the wallet holds the coin and gas; and right before each transaction, the server and the contract must still price the plan
// as confirmed. `--entry-tx` registers an entry already paid, without paying again.
import { AUSD, ENTRY_ATTEMPTS, KURU_ROUTER, MAX_ASSESSMENTS, MAX_FUNDED_USD, MON_DEADLINE_S, MON_RESERVE_WEI, USDC } from './constants.ts'
import { approveCall, enterCall, enterWithMonCall, usd6, type Call } from './chain.ts'
import { CHAIN_LABEL, signIn, type Deps, type Plan } from './context.ts'
import { PluginError } from './errors.ts'
import { coin, mon, pct, planName, txUrl, usd } from './format.ts'
import { floorFromSwap, quoteMonFee, unconfirmed } from './kuru.ts'
import type { Address, Hex, Me, PayWith, Tier } from './types.ts'
import { accountView } from './views.ts'

export type BuyInput = { size: number; pay: PayWith; entryTx?: Hex }

const sizeFlag = (size: number) => (size % 1000 === 0 ? `${size / 1000}k` : String(size))
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const NEXT = 'Nothing was signed or paid. Run the same command again with --yes to sign and pay.'

// `call` is the transaction as planned; `fresh` (a fee in MON) builds it again right before it is
// signed, from what the chain says then.
type Step = { call: Call; fresh?: () => Promise<Call>; summary: string; step: string }

// A plan being repriced: for the minute between an admin's edit on the server and the owner's
// setTier on the contract, the two disagree on its fee. Paying then pays the wrong amount (the
// server refuses an entry below the plan's current fee), so nothing is signed.
const feeChanging = (listedUsd: number, onchain: bigint) =>
  new PluginError('FEE_CHANGING', `This plan’s price is being updated on the contract (it charges ${usd(Number(onchain) / 1e6)}; MonFunded lists ${usd(listedUsd)}), so nothing was paid.`, 'Try again in a minute; `mm monfunded status` shows the plans and their fees.')

// The server's two limits per wallet (a practice account counts toward neither). It checks them
// when the entry is registered, after the fee is paid, so they are checked here first.
const running = (me: Me) => me.active.filter((c) => !c.demo && c.status === 'assessment')
const fundedUsd = (me: Me) => me.active.filter((c) => !c.demo && c.status === 'funded').reduce((sum, c) => sum + c.rules.size, 0)
function underLimits(me: Me, tier: Tier) {
  const count = running(me).length
  if (count >= MAX_ASSESSMENTS) throw new PluginError('TOO_MANY_ASSESSMENTS', `This wallet already has ${count} assessments running, and MonFunded allows ${MAX_ASSESSMENTS} at a time. The fee was not paid.`, 'Pass or fail one first; `mm monfunded status` shows their progress.')
  const held = fundedUsd(me)
  if (held + tier.size > MAX_FUNDED_USD) throw new PluginError('FUNDED_CAP', `This wallet holds ${usd(held)} of funded accounts, and one wallet may hold ${usd(MAX_FUNDED_USD)} at most: a ${usd(tier.size)} plan would pass it. The fee was not paid.`, 'Pick a smaller --size; `mm monfunded status` shows the funded accounts.')
}

// Right before each transaction: the plan as the server lists it now, and the contract's fee for
// its index, must both still be the fee the user confirmed, and the wallet still under its limits
// (an assessment can pass, or another buy land, while MetaMask waits for an approval).
async function stillPriced(d: Deps, contract: Address, tier: Tier) {
  const [config, onchain, me] = await Promise.all([d.api.config(), d.reader.tierFee(contract, tier.index), d.api.me()])
  underLimits(me, tier)
  const now = config.tiers.find((t) => t.id === tier.id)
  if (!now || now.enabled === false || !config.contract || !same(config.contract, contract)) throw new PluginError('ENTRIES_CLOSED', 'That plan stopped taking entries while the payment was shown, so nothing was paid.', 'Run `mm monfunded status` to see the plans on sale.')
  if (now.index !== tier.index || now.feeUsd !== tier.feeUsd || onchain !== usd6(tier.feeUsd)) throw feeChanging(now.feeUsd, onchain)
}

export async function buy(d: Deps, input: BuyInput) {
  signIn(d)
  const config = await d.api.config()
  const contract = config.contract
  if (!contract) throw new PluginError('ENTRIES_CLOSED', 'MonFunded is taking no entries right now (it names no contract to pay), so nothing was paid.', 'Run `mm monfunded status` later: it says when entries are open.')
  const tier = config.tiers.find((t) => t.size === input.size && t.enabled !== false)
  if (!tier) {
    const sizes = config.tiers.filter((t) => t.enabled !== false).map((t) => sizeFlag(t.size))
    throw new PluginError('UNKNOWN_PLAN', `MonFunded sells no plan of $${input.size.toLocaleString('en-US')}.`, sizes.length ? `On sale: --size ${sizes.join(', ')}.` : 'Run `mm monfunded status` to see the plans on sale.')
  }
  const me = await d.api.me()
  const again = `mm monfunded buy --size ${sizeFlag(tier.size)} --pay ${input.pay.toLowerCase()}`
  // An entry already paid is the server's to judge: nothing is paid here, so nothing is checked first.
  if (input.entryTx) return register(d, tier, input.entryTx, again)
  underLimits(me, tier)
  // Under the limit now, but over it if the assessments running pass first: said before the payment.
  const pending = running(me).reduce((sum, c) => sum + c.rules.size, 0)
  const mayVoid = fundedUsd(me) + tier.size + pending > MAX_FUNDED_USD

  // The contract must take the coins MonFunded names and charge exactly the plan's listed fee
  // (tiers(index)), whichever coin pays: the contract charges its own number, the server wants its.
  const fee = usd6(tier.feeUsd)
  const [onchainFee, coins] = await Promise.all([d.reader.tierFee(contract, tier.index), d.reader.coins(contract)])
  if (!same(coins.usdc, USDC) || !same(coins.ausd, AUSD)) throw new PluginError('BAD_CONTRACT', `The contract ${contract} does not take MonFunded’s USDC and AUSD, so nothing was paid.`, 'If MONFUNDED_API_URL is set, check it points at MonFunded.')
  if (onchainFee !== fee) throw feeChanging(tier.feeUsd, onchainFee)

  const name = planName(tier)
  const steps: Step[] = []
  let amount: string
  if (input.pay === 'MON') {
    const market = config.monMarket
    if (!market) throw new PluginError('MON_UNAVAILABLE', 'MonFunded doesn’t know Kuru’s MON_USDC book right now, so the fee can’t be paid in MON.', 'Pay with --pay usdc or --pay ausd, or try again in a minute.')
    const quote = await quoteMonFee(d.kuru, tier.feeUsd, market)
    const balance = await d.reader.nativeBalance(d.wallet)
    if (balance < quote.monWei + MON_RESERVE_WEI) throw new PluginError('INSUFFICIENT_FUNDS', `Paying ${mon(quote.monWei)} needs ${mon(quote.monWei + MON_RESERVE_WEI)} in the wallet (Monad keeps 10 MON in every account), and it holds ${mon(balance)}.`, 'Add MON with `mm wallet add-fund`, or pay with --pay usdc or --pay ausd.')
    // The MON was quoted from Kuru's HTTP API alone. What it really sells for is asked of the chain
    // (the router's own swap, as a call): short of the fee, or far more than the fee needs — the sign
    // of a wrong API answer — signs nothing; otherwise the swap's floor is that output less 0.5 %,
    // never under the fee. Asked now, for the plan shown, and again right before the transaction.
    const monCall = async () => {
      // The contract must swap on the router the simulation asks, or what it fills is not what was simulated.
      if (!same(await d.reader.router(contract), KURU_ROUTER)) throw new PluginError('BAD_CONTRACT', `The contract ${contract} doesn’t swap MON on Kuru’s router, so the MON price can’t be confirmed and nothing was signed.`, 'Pay with --pay usdc or --pay ausd.')
      // The deadline counts from the chain's own clock, never this computer's; no clock, nothing signed.
      const [out, time] = await Promise.all([d.reader.simulateMonSwap(d.wallet, market, quote.monWei).catch(() => undefined), d.reader.chainTime().catch(() => undefined)])
      const check = out === undefined ? undefined : floorFromSwap(out, tier.feeUsd)
      // Seconds since 1970, or it is no clock: milliseconds would make a deadline that never comes.
      if (!check || !check.ok || time === undefined || !(time > 1_000_000_000n && time < 100_000_000_000n)) throw unconfirmed()
      return { floor: check.floor, call: enterWithMonCall(contract, tier.index, market, check.floor, time + MON_DEADLINE_S, quote.monWei) }
    }
    const planned = await monCall()
    amount = `${mon(quote.monWei)} (the ${usd(tier.feeUsd)} fee at Kuru’s best bid of ${quote.bestBid} USDC per MON, plus a 0.5 % buffer; any USDC the swap produces above the fee comes back to this wallet)`
    steps.push({
      call: planned.call,
      fresh: async () => (await monCall()).call,
      summary: `MonFunded: pay the ${name} assessment with ${mon(quote.monWei)}`,
      step: `enterWithMon(${tier.index}, ${market}, ${planned.floor}, a deadline ${MON_DEADLINE_S / 60n} minutes after the request) on ${contract}, sending ${mon(quote.monWei)}: the contract sells it on Kuru, keeps the ${coin(tier.feeUsd, 'USDC')} fee and sends the rest back; the swap must produce at least ${coin(Number(planned.floor) / 1e6, 'USDC')} (checked again on Monad right before the request) and land within ${MON_DEADLINE_S / 60n} minutes of it, any wallet approval included, or the whole transaction reverts (gas only; nothing else is taken).`,
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
      ...(tier.rules.consistencyPct !== undefined ? [`Consistency: no single day may be worth more than ${pct(tier.rules.consistencyPct)} of the profit; until then the pass waits.`] : []),
      'The fee is not refundable once the account is active.',
      ...(mayVoid ? [`This wallet’s funded accounts and running assessments come to more than ${usd(MAX_FUNDED_USD)} with this plan: if an assessment passes before this entry is registered, MonFunded refuses the entry after the fee is paid. Buy one account at a time.`] : []),
    ],
  }
  if (!(await d.confirm(plan))) return { done: false as const, plan, next: NEXT, summary: [NEXT] }
  const signer = await d.signer()
  let entryTx: Hex | undefined
  // The plan may be repriced while it is shown, or between its approval and its entry: each
  // transaction goes only while the server and the contract still price it as confirmed.
  for (const s of steps) {
    await stillPriced(d, contract, tier)
    const call = s.fresh ? await s.fresh() : s.call
    // The last step pays the fee. One that MetaMask holds for an approval, or that was sent and not
    // confirmed in time, may still pay it after this command has given up: the refusal then says
    // how to register that payment, and never to pay again on top of it.
    entryTx = await signer.send(call, s.summary).catch((e: unknown) => {
      if (s !== steps.at(-1) || !(e instanceof PluginError)) throw e
      if (e.code === 'TX_UNCONFIRMED' && e.tx) throw new PluginError(e.code, e.message, `Don’t pay again: the fee may be paid. Once ${txUrl(e.tx as Hex)} is confirmed, register it: ${again} --entry-tx ${e.tx}`, e.tx)
      if (e.code === 'NOT_SIGNED') throw new PluginError(e.code, `${e.message} The fee was not paid by this command.`, `If the fee’s request is waiting for an approval in MetaMask (\`mm wallet requests list\`), choose one, never both, or it pays the fee twice: approve it there and then register that payment with ${again} --entry-tx <the transaction’s hash>; or reject it and run this command again.`)
      throw e
    })
  }
  return { ...(await register(d, tier, entryTx as Hex, again)), plan }
}

// The server's refusals that registering again can't change: the plan's price went up after the
// payment, or the entry is older than the server takes.
const FINAL = new Set(['ENTRY_UNDERPAID', 'ENTRY_EXPIRED'])
const UNREAD = new Set(['BAD_RESPONSE', 'NOT_JSON', 'NETWORK', 'ABORTED'])

// Registers a mined entry with MonFunded and returns the new account. The server reads the
// receipt from its own RPC, which can trail the wallet's by a block or two: an entry it can't
// verify yet is retried. Any other failure comes after the fee is paid, and says so under one code
// of its own (PAID_NOT_REGISTERED, never the server's, which before a payment means nothing was
// paid) with how to register the entry without paying again; those registering again can't fix
// (FINAL) keep their own code and hint. An answer the plugin could not read or did not get
// (UNREAD) is not a refusal: the account may have started.
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
      if (e instanceof PluginError && FINAL.has(e.code)) throw new PluginError(e.code, `${why} The entry is ${entryTx}.`, e.hint)
      if (e instanceof PluginError && e.code === 'ENTRY_NOT_VERIFIED') throw new PluginError(e.code, `${why} The entry is ${entryTx}.`, `Register it without paying again: ${again} --entry-tx ${entryTx}`)
      if (e instanceof PluginError && UNREAD.has(e.code))
        throw new PluginError('PAID_UNCONFIRMED', `The fee is paid, and the account may or may not have started: the plugin got no answer it could read from MonFunded (${e.code}). ${why} The entry is ${entryTx}.`, `Don’t pay again. Run \`mm monfunded status\` first: if the new account is listed, it started. If it is not, register the entry within 72 hours of its payment: ${again} --entry-tx ${entryTx}`)
      throw new PluginError(
        'PAID_NOT_REGISTERED',
        `The fee is paid, but MonFunded did not start the account${e instanceof PluginError ? ` (${e.code})` : ''}: ${why} The entry is ${entryTx}.`,
        `Don’t pay again. Once what refused it has changed, register this entry within 72 hours of its payment: ${again} --entry-tx ${entryTx} (if that can’t be done in time, open a support ticket in the MonFunded dashboard, https://monfunded.com/app/#support, with the entry transaction).`,
      )
    }
  }
}
