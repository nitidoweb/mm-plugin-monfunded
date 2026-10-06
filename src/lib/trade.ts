// `mm monfunded coach`, `order` and `close`: trading a MonFunded account (simulated at Perpl's and
// MonFunded liquidity's live prices, so nothing is signed). The coach runs the server's order checks and the account's rules
// against an intended order and says what would happen, without sending it; `order` runs the same
// checks first, sends the order and waits for its fill; `close` respects the 60 s minimum hold and
// waits for the close.
import { CAUTION_MOVE_PCT, categoryOf, FILL_WAIT_MS, MARGIN_CALL_PCT, MIN_HOLD_MS, MIN_NOTIONAL_USD, POLL_MS, sourceOf, STOP_OUT_PCT } from './constants.ts'
import { pickAccount, signIn, type Deps } from './context.ts'
import { PluginError } from './errors.ts'
import { isoTime, pct, symbolOf, usd } from './format.ts'
import type { Challenge, Position, Prices, Quote, Side } from './types.ts'
import { positionView } from './views.ts'

export type OrderInput = { market: string; side: Side; notional: number; leverage: number; account?: string }
export type CloseInput = { position: string; account?: string }

const cents = (n: number) => Math.round(n * 100) / 100
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits
const price = (n: number) => Number(n.toPrecision(6))

// `others`: the wallet's other paid accounts (the server refuses opposite sides across them).
type Setup = { account: Challenge; others: Challenge[]; prices: Prices; quote: Quote | undefined; cap: number; planCap: number; perplCap: number | undefined; usedMargin: number; freeMargin: number; margin: number }

async function setup(d: Deps, input: OrderInput): Promise<Setup> {
  signIn(d)
  const [me, prices] = await Promise.all([d.api.me(), d.api.prices()])
  const account = pickAccount(me, input.account)
  const quote = prices[input.market]
  // The plan's cap for the market's category; the quote adds the market's own (Perpl's maximum, or
  // MonFunded liquidity's category cap).
  const planCap = account.rules.leverage[categoryOf(input.market)] ?? 1
  const perplCap = quote?.maxLeverage
  // Margin in use and free margin as the server reports them (at current prices); an account
  // without them: equity less the margin every pending, open and closing position locks.
  const used = account.progress.margin?.used ?? account.positions.reduce((sum, p) => sum + p.margin, 0)
  const others = me.active.filter((c) => c.id !== account.id && !c.demo && !account.demo)
  return { account, others, prices, quote, cap: Math.min(planCap, perplCap ?? Infinity), planCap, perplCap, usedMargin: used, freeMargin: account.progress.margin?.free ?? cents(account.progress.equity - used), margin: cents(input.notional / input.leverage) }
}

// Why the server would refuse the order, in the order it checks; undefined when it would take it.
function refusal(input: OrderInput, s: Setup): PluginError | undefined {
  const symbol = symbolOf(input.market)
  if (s.account.payoutPending) return new PluginError('PAYOUT_PENDING', `Account ${s.account.id} has a payout waiting on a decision, so it takes no new order until it is released or declined.`, 'Run `mm monfunded status` to see the payout.')
  if (s.account.frozen) return new PluginError('FEED_PAUSED', `Account ${s.account.id} is frozen: one of its positions has no live price, so it takes no order on any market until it does.`, 'Try again in a moment; `mm monfunded status` shows the account.')
  if (!s.quote) return new PluginError('UNKNOWN_MARKET', `The challenge has no ${symbol} market.`, `Markets: ${Object.keys(s.prices).map(symbolOf).join(', ')}.`)
  if (!s.quote.tradable) return new PluginError('MARKET_CLOSED', `${symbol} is not tradable right now (its market is closed, a MonFunded liquidity instrument outside its hours or paused, or its quote is stale or broken).`, 'Try again later, or pick another market.')
  const otherSide = input.side === 'long' ? 'short' : 'long'
  const opposite = (c: Challenge) => c.positions.find((p) => p.marketId === input.market && p.side === otherSide)
  const held = opposite(s.account)
  if (held) return new PluginError('HEDGING', `The account is already ${otherSide} ${symbol} (${held.id}), and MonFunded takes one side of a market at a time.`, `Close ${held.id} first.`)
  const across = s.others.find(opposite)
  if (across) return new PluginError('CROSS_HEDGE', `Another account of this wallet (${across.id}) is ${otherSide} ${symbol}, and MonFunded refuses opposite sides across a wallet’s own accounts.`, 'Close that position first, or trade the same side.')
  if (input.leverage > s.cap) return new PluginError('LEVERAGE_TOO_HIGH', `${input.leverage}x is above the ${s.cap}x cap on ${symbol} (the plan allows ${s.planCap}x${s.perplCap ? `, ${sourceOf(input.market)} ${s.perplCap}x` : ''}).`, `Pass --leverage ${s.cap} or less.`)
  if (input.notional < MIN_NOTIONAL_USD) return new PluginError('SIZE_TOO_SMALL', `Positions start at ${usd(MIN_NOTIONAL_USD)} of notional.`, `Pass --notional ${MIN_NOTIONAL_USD} or more.`)
  if (s.margin > s.freeMargin) return new PluginError('INSUFFICIENT_MARGIN', `This position needs ${usd(s.margin)} of margin (notional ÷ leverage) and the account has ${usd(s.freeMargin)} free.`, 'Lower --notional, raise --leverage within the cap, or close a position first.')
  return undefined
}

// What the order risks: where it fills, the adverse move that fails the account (the smaller of
// today's loss room and the drawdown room, less what the fill costs at once against the mark, on
// this position alone), and the account's margin level (equity ÷ margin in use) once it is open.
function riskOf(input: OrderInput, s: Setup, q: Quote) {
  const account = s.account
  const long = input.side === 'long'
  const entry = long ? (q.ask ?? q.price) : (q.bid ?? q.price)
  const entryCost = Math.max(0, input.notional * (long ? 1 - q.price / entry : q.price / entry - 1))
  const p = account.progress
  const dailyRoom = Math.max(0, p.dailyLimit + p.dailyPnl)
  const drawdownRoom = Math.max(0, p.drawdownRoom)
  const failsOn = dailyRoom <= drawdownRoom ? 'daily loss' : 'maximum drawdown'
  const failMovePct = Math.max(0, ((Math.min(dailyRoom, drawdownRoom) - entryCost) / input.notional) * 100)
  const marginLevelPct = ((p.equity - entryCost) / (s.usedMargin + s.margin)) * 100
  const spread = q.bid && q.ask ? input.notional * ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) : undefined
  return {
    entryPrice: entry,
    markPrice: q.price,
    entryCostUsd: cents(entryCost),
    failMovePct: round(failMovePct),
    failsOn,
    failPrice: price(entry * (1 + ((long ? -1 : 1) * failMovePct) / 100)),
    marginLevelPct: round(marginLevelPct),
    ...(spread !== undefined && { roundTripSpreadUsd: cents(spread) }),
    minimumHoldSeconds: MIN_HOLD_MS / 1000,
  }
}

export async function coach(d: Deps, input: OrderInput) {
  const s = await setup(d, input)
  const symbol = symbolOf(input.market)
  const blocked = refusal(input, s)
  const q = s.quote
  const checks = [
    { check: 'market', ok: !!q?.tradable, detail: !q ? `the challenge has no ${symbol} market` : q.tradable ? `${symbol} is open (mark ${q.price})` : `${symbol} is not tradable right now` },
    { check: 'hedge', ok: blocked?.code !== 'HEDGING' && blocked?.code !== 'CROSS_HEDGE', detail: blocked?.code === 'HEDGING' || blocked?.code === 'CROSS_HEDGE' ? `this wallet already holds the other side of ${symbol}` : `no position on the other side of ${symbol}` },
    { check: 'leverage', ok: input.leverage <= s.cap, detail: `${input.leverage}x, cap ${s.cap}x (plan ${s.planCap}x${s.perplCap ? `, ${sourceOf(input.market)} ${s.perplCap}x` : ''})` },
    { check: 'size', ok: input.notional >= MIN_NOTIONAL_USD, detail: `${usd(input.notional)} (minimum ${usd(MIN_NOTIONAL_USD)})` },
    { check: 'margin', ok: s.margin <= s.freeMargin, detail: `${usd(s.margin)} needed, ${usd(s.freeMargin)} free` },
  ]
  const risk = q ? riskOf(input, s, q) : undefined
  // Room the plugin could not read is not room: never ok on a figure that is not one.
  const unread = risk !== undefined && !Number.isFinite(risk.failMovePct)
  const verdict = blocked ? 'blocked' : risk && (unread || risk.failMovePct < CAUTION_MOVE_PCT) ? 'caution' : 'ok'
  const summary: string[] = []
  if (blocked) summary.push(`MonFunded would refuse this order: ${blocked.message} ${blocked.hint}`)
  if (risk) {
    const way = input.side === 'long' ? 'down' : 'up'
    summary.push(`A ${pct(risk.failMovePct)} move against you (${symbol} ${way} to about ${risk.failPrice}) fails the account on its ${risk.failsOn} limit${s.account.positions.length ? ', not counting your other open positions' : ''}.`)
    summary.push(`It locks ${usd(s.margin)} of margin and leaves the account’s margin level at ${pct(risk.marginLevelPct)}: at ${MARGIN_CALL_PCT} % the account shows a margin call, and at ${STOP_OUT_PCT} % the server closes its largest losing position.`)
    summary.push(`It fills at the next ${sourceOf(input.market)} quote, near ${risk.entryPrice} (the ${input.side === 'long' ? 'ask' : 'bid'}), and must stay open ${risk.minimumHoldSeconds} s before it can be closed.`)
    if (risk.roundTripSpreadUsd !== undefined) summary.push(`Opening and closing costs about ${usd(risk.roundTripSpreadUsd)} in spread.`)
    if (verdict === 'caution') summary.push(unread ? 'Caution: the account’s loss room could not be read, so how far the price can move against this order is unknown. Run `mm monfunded status` before sending it.' : `Caution: a move under ${pct(CAUTION_MOVE_PCT)} is an ordinary one. A smaller --notional leaves more room.`)
  }
  return { verdict, account: s.account.id, market: symbol, side: input.side, notionalUsd: input.notional, leverage: input.leverage, marginUsd: s.margin, checks, ...(risk && { risk }), summary }
}

// Polls the account until the position has left `from` (a fill or a cancel, or a close), for up to
// FILL_WAIT_MS; then it reports the position as it stands.
async function settle(d: Deps, accountId: string, first: Position, from: 'pending' | 'closing'): Promise<{ position: Position; account: Challenge }> {
  const deadline = d.now() + FILL_WAIT_MS
  for (;;) {
    const account = await d.api.account(accountId)
    const live = account.positions.find((p) => p.id === first.id)
    if (live && live.status !== from) return { position: live, account }
    if (!live) {
      const ended = (await d.api.history(accountId)).find((p) => p.id === first.id)
      if (ended) return { position: ended, account }
    }
    if (d.now() >= deadline) return { position: live ?? first, account }
    await d.sleep(POLL_MS)
  }
}

export async function order(d: Deps, input: OrderInput) {
  const s = await setup(d, input)
  const blocked = refusal(input, s)
  if (blocked) throw blocked
  const { position } = await d.api.order(s.account.id, { marketId: input.market, side: input.side, notional: input.notional, leverage: input.leverage })
  const { position: now } = await settle(d, s.account.id, position, 'pending')
  const view = positionView(now, await d.api.prices(), d.now())
  const next = now.status === 'open' ? `Close it with \`mm monfunded close --position ${now.id}\` once the 60 s hold is over.` : now.status === 'pending' ? 'Still waiting for a fresh Perpl quote: `mm monfunded status` shows when it fills.' : 'No fresh Perpl quote came in time, so the order was cancelled; try again.'
  return { account: s.account.id, position: view, summary: [view.summary, next] }
}

export async function close(d: Deps, input: CloseInput) {
  signIn(d)
  const me = await d.api.me()
  const pool = input.account ? me.active.filter((c) => c.id === input.account) : me.active
  const account = pool.find((c) => c.positions.some((p) => p.id === input.position))
  const p = account?.positions.find((x) => x.id === input.position)
  if (!account || !p) throw new PluginError('POSITION_NOT_FOUND', `No pending or open position ${input.position} on ${input.account ? `account ${input.account}` : 'this wallet’s running accounts'}.`, 'Run `mm monfunded status` to list open positions.')
  const now = d.now()
  if (p.status === 'open' && p.openedAt !== undefined && now < p.openedAt + MIN_HOLD_MS) {
    const at = p.openedAt + MIN_HOLD_MS
    throw new PluginError('HOLD_TIME', `Positions stay open at least 60 s after their fill; ${p.id} can close from ${isoTime(at)} (in ${Math.ceil((at - now) / 1000)} s).`, 'Wait, then run the same command again.')
  }
  // A pending order is the server's to fill or let lapse, never the trader's to cancel.
  if (p.status === 'pending') throw new PluginError('ORDER_PENDING', `${p.id} is an order still filling: a pending order can’t be cancelled.`, 'Wait a few seconds: it fills or lapses by itself. Close it once it has filled and its 60 s hold is over.')
  // An open position closes at the next quote after the server's short delay.
  if (p.status !== 'closing') await d.api.close(account.id, p.id)
  const settled = await settle(d, account.id, p, 'closing')
  const after = settled.account
  const view = positionView(settled.position, {}, d.now())
  const summary = [view.summary]
  // A forex close that meets no fresh quote in time lapses: the position is open again.
  if (settled.position.status === 'open') summary.push('No fresh MonFunded liquidity quote came within 10 s, so the close lapsed and the position is open again: run the same command to try again.')
  const passed = account.status === 'assessment' && after.status === 'funded'
  const k = after.progress.consistency
  if (passed) summary.push(`Passed: the assessment reached its target, so account ${after.id} is now funded (balance reset to ${usd(after.rules.size)}). Profit made from here can be withdrawn.`)
  else if (after.status === 'assessment' && k && !k.ok && after.progress.profit >= after.progress.target && !after.positions.length)
    summary.push(`Account ${after.id} has reached its profit target (${usd(after.progress.profit)} of ${usd(after.progress.target)}), but the pass waits on the consistency rule: its best day (${usd(k.bestDay)}) is ${pct(k.sharePct)} of the profit and the limit is ${pct(k.limitPct)}. It passes once the profit reaches ${usd(k.need)}, made on other days.`)
  else if (after.status === 'failed') summary.push(`Account ${after.id} has failed (${after.reason ?? 'a rule'}).`)
  else summary.push(`Account ${after.id}: balance ${usd(after.progress.balance)}, equity ${usd(after.progress.equity)}.`)
  return { account: after.id, accountStatus: after.status, passed, balanceUsd: after.progress.balance, equityUsd: after.progress.equity, position: view, summary }
}
