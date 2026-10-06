// Accounts, positions and withdrawals as the commands report them: the numbers an agent reads (USD
// figures end in Usd) and one plain sentence each for people.
import { MIN_HOLD_MS, STOP_OUT_PCT } from './constants.ts'
import { coin, pct, planName, signedUsd, symbolOf, txUrl, usd } from './format.ts'
import type { Challenge, ChallengeStatus, Hex, PayoutToken, Position, PositionStatus, Prices, Side, Tier, Withdrawal } from './types.ts'

const cents = (n: number) => Math.round(n * 100) / 100
const iso = (ms: number) => new Date(ms).toISOString()

export type PositionView = {
  id: string
  market: string
  side: Side
  status: PositionStatus
  notionalUsd: number
  leverage: number
  marginUsd: number
  entryPrice?: number
  markPrice?: number
  exitPrice?: number
  pnlUsd?: number
  // Open positions: when the 60 s minimum hold ends.
  closableFrom?: string
  closedBy?: Position['closedBy']
  summary: string
}

// Who closed a position, when it was not the trader's own close ('liquidation' is the rule the
// stop-out replaced, still on positions closed before it).
const ENDED_BY: Record<NonNullable<Position['closedBy']>, string> = {
  trader: '',
  liquidation: ' (liquidated)',
  stopOut: ` (closed by the stop-out: the account’s margin level fell to ${STOP_OUT_PCT} %)`,
  end: ' (closed when the account ended)',
  guard: ' (closed by the account’s equity guard)',
  sl: ' (its stop-loss was hit)',
  tp: ' (its take-profit was hit)',
}

export function positionView(p: Position, prices: Prices, now: number): PositionView {
  const mark = prices[p.marketId]?.price
  const filled = p.status === 'open' || p.status === 'closing'
  // Unrealized P&L at the mark, no spread (the server's equity does the same).
  const pnl = p.pnl ?? (filled && p.entryPrice && mark ? cents(p.notional * (p.side === 'long' ? mark / p.entryPrice - 1 : 1 - mark / p.entryPrice)) : undefined)
  const closable = p.status === 'open' && p.openedAt !== undefined ? p.openedAt + MIN_HOLD_MS : undefined
  const head = `${p.id}: ${symbolOf(p.marketId)} ${p.side} ${usd(p.notional)} at ${p.leverage}x`
  const endedBy = p.closedBy && Object.hasOwn(ENDED_BY, p.closedBy) ? ENDED_BY[p.closedBy] : ''
  const summary =
    p.status === 'pending'
      ? `${head}, waiting for its fill at the next Perpl quote (${usd(p.margin)} margin locked).`
      : p.status === 'open'
        ? `${head}, filled at ${p.entryPrice}, mark ${mark ?? 'unknown'}, P&L ${signedUsd(pnl ?? 0)}; ${closable !== undefined && closable > now ? `can close from ${iso(closable)}` : 'can close now'}.`
        : p.status === 'closing'
          ? `${head}, closing at the next Perpl quote (P&L so far ${signedUsd(pnl ?? 0)}).`
          : p.status === 'closed'
            ? `${head}, closed at ${p.exitPrice}${endedBy}: P&L ${signedUsd(p.pnl ?? 0)}.`
            : `${head}, cancelled before it filled; its margin is free again.`
  return {
    id: p.id,
    market: symbolOf(p.marketId),
    side: p.side,
    status: p.status,
    notionalUsd: p.notional,
    leverage: p.leverage,
    marginUsd: p.margin,
    ...(p.entryPrice !== undefined && { entryPrice: p.entryPrice }),
    ...(filled && mark !== undefined && { markPrice: mark }),
    ...(p.exitPrice !== undefined && { exitPrice: p.exitPrice }),
    ...(pnl !== undefined && { pnlUsd: pnl }),
    ...(closable !== undefined && { closableFrom: iso(closable) }),
    ...(p.closedBy && { closedBy: p.closedBy }),
    summary,
  }
}

// paid: the payout landed (the operator's, or the trader's own claim); review: held for a
// person's decision; rejected: declined, never paid; queued: released, waiting for room under the
// contract's daily payout limit; unpaid: owed, the operator pays it or the trader claims it.
type WithdrawalState = 'paid' | 'review' | 'rejected' | 'queued' | 'unpaid'

export type WithdrawalView = {
  id: string
  amountUsd: number
  paidUsd: number
  token: PayoutToken
  state: WithdrawalState
  requestedAt: string
  paidAt?: string
  tx?: Hex
  explorer?: string
  summary: string
}

export function withdrawalView(w: Withdrawal): WithdrawalView {
  // A state this version has no name for is one that isn't paid and can't be claimed: it reads as held.
  const state: WithdrawalState = w.paidAt !== undefined ? 'paid' : w.status === undefined ? 'unpaid' : w.status === 'rejected' || w.status === 'queued' ? w.status : 'review'
  const head = `${w.id}: ${usd(w.amountUsd)} off the balance, ${coin(w.paidUsd, w.token)} to you`
  const summary =
    state === 'paid'
      ? `${head}, paid${w.tx ? ` in ${txUrl(w.tx)}` : ' (claimed from the contract)'}.`
      : state === 'review'
        ? `${head}, held for review: MonFunded checks every payout, and a person decides on this one before it pays.`
        : state === 'rejected'
          ? `${head}, declined after review: it will not be paid.`
          : state === 'queued'
            ? `${head}, released and waiting its turn: the contract’s daily payout limit is reached, and MonFunded sends it by itself once there is room.`
            : `${head}, not paid yet: MonFunded’s operator pays it automatically, or collect it yourself with \`mm monfunded claim --withdrawal ${w.id}\`.`
  return {
    id: w.id,
    amountUsd: w.amountUsd,
    paidUsd: w.paidUsd,
    token: w.token,
    state,
    requestedAt: iso(w.requestedAt),
    ...(w.paidAt !== undefined && { paidAt: iso(w.paidAt) }),
    ...(w.tx && { tx: w.tx, explorer: txUrl(w.tx) }),
    summary,
  }
}

export type AccountView = {
  id: string
  plan: string
  status: ChallengeStatus
  reason?: Challenge['reason']
  balanceUsd: number
  equityUsd: number
  // Assessment only: realized profit toward the target.
  profitTarget?: { profitUsd: number; targetUsd: number; progressPct: number }
  // How much equity can still fall today, and in total, before the account fails.
  dailyLoss: { roomUsd: number; limitUsd: number; todayPnlUsd: number }
  drawdown: { roomUsd: number; floorUsd: number }
  // Funded only: profit that can be withdrawn now, and what it pays.
  withdrawable?: { amountUsd: number; youReceiveUsd: number }
  // The consistency rule: the best day's share of the phase's profit against its limit; when it is
  // over, the profit that brings it back inside (an assessment's pass waits for it).
  consistency?: { bestDayUsd: number; sharePct: number; limitPct: number; ok: boolean; profitNeededUsd: number }
  // Equity ÷ margin in use, in %, while positions use margin.
  marginLevelPct?: number
  // No order, withdrawal or claim goes through: a position has no live price (frozen), or a payout
  // is waiting on a decision (payoutPending: no new order).
  frozen?: true
  payoutPending?: true
  positions: PositionView[]
  withdrawals: WithdrawalView[]
  summary: string[]
}

const FAIL_REASON = { dailyLoss: 'the daily loss limit', maxDrawdown: 'the maximum drawdown', conduct: 'MonFunded’s conduct rules' }

export function accountView(c: Challenge, tiers: Tier[], prices: Prices, now: number): AccountView {
  const tier = tiers.find((t) => t.id === c.tier)
  const plan = tier ? planName(tier) : c.tier
  const p = c.progress
  const dailyRoom = cents(Math.max(0, p.dailyLimit + p.dailyPnl))
  const positions = c.positions.map((x) => positionView(x, prices, now))
  const withdrawals = c.withdrawals.map(withdrawalView)
  const kind = c.status === 'assessment' ? 'assessment' : c.status === 'funded' ? 'funded account' : 'account'
  const summary = [`${plan} ${kind} ${c.id}${c.status === 'failed' ? `, failed on ${c.reason && Object.hasOwn(FAIL_REASON, c.reason) ? FAIL_REASON[c.reason] : 'a rule'}` : ''}: equity ${usd(p.equity)}, balance ${usd(p.balance)}.`]
  if (c.status === 'assessment') summary.push(`Profit target: ${usd(p.profit)} of ${usd(p.target)} (${pct(p.target > 0 ? (p.profit / p.target) * 100 : 0)}); it counts once no position is open.`)
  const k = p.consistency
  const consistency = k && k.bestDay > 0 ? { bestDayUsd: k.bestDay, sharePct: k.sharePct, limitPct: k.limitPct, ok: k.ok, profitNeededUsd: k.need } : undefined
  if (consistency && c.status !== 'failed')
    summary.push(`Consistency: the best day (${usd(consistency.bestDayUsd)}) is ${pct(consistency.sharePct)} of this phase’s profit; the limit is ${pct(consistency.limitPct)}${consistency.ok ? '' : c.status === 'assessment' ? `, so the pass waits until the profit reaches ${usd(consistency.profitNeededUsd)}` : ', so a payout asked now is held for a person’s review'}.`)
  if (c.status === 'funded') summary.push(`Withdrawable now: ${usd(p.withdrawable)} (you receive ${usd(p.withdrawablePaid)}).`)
  if (c.status !== 'failed') summary.push(`Daily loss room: ${usd(dailyRoom)} (the account fails ${usd(p.dailyLimit)} below today’s opening equity; today ${signedUsd(p.dailyPnl)}).`, `Drawdown room: ${usd(p.drawdownRoom)} above the ${usd(p.drawdownFloor)} floor.`)
  const level = p.margin?.level ?? undefined
  if (level !== undefined && c.status !== 'failed') summary.push(`Margin level: ${pct(level)} (${usd(p.margin?.used ?? 0)} in use, ${usd(p.margin?.free ?? 0)} free)${p.margin?.call ? `: a margin call. At ${STOP_OUT_PCT} % the server closes the largest losing position` : ''}.`)
  if (c.frozen) summary.push('Frozen: one of its positions has no live price, so no order, withdrawal or claim goes through until it does.')
  if (c.payoutPending) summary.push('A payout is waiting on a decision: the account takes no new order until it is released or declined.')
  summary.push(...positions.map((x) => x.summary), ...withdrawals.map((x) => x.summary))
  return {
    id: c.id,
    plan,
    status: c.status,
    ...(c.reason && { reason: c.reason }),
    balanceUsd: p.balance,
    equityUsd: p.equity,
    ...(c.status === 'assessment' && { profitTarget: { profitUsd: p.profit, targetUsd: p.target, progressPct: p.target > 0 ? cents((p.profit / p.target) * 100) : 0 } }),
    dailyLoss: { roomUsd: dailyRoom, limitUsd: p.dailyLimit, todayPnlUsd: p.dailyPnl },
    drawdown: { roomUsd: p.drawdownRoom, floorUsd: p.drawdownFloor },
    ...(c.status === 'funded' && { withdrawable: { amountUsd: p.withdrawable, youReceiveUsd: p.withdrawablePaid } }),
    ...(consistency && { consistency }),
    ...(level !== undefined && { marginLevelPct: level }),
    ...(c.frozen && { frozen: true as const }),
    ...(c.payoutPending && { payoutPending: true as const }),
    positions,
    withdrawals,
    summary,
  }
}
