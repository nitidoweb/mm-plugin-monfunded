// Accounts, positions and withdrawals as the commands report them: the numbers an agent reads (USD
// figures end in Usd) and one plain sentence each for people.
import { MIN_HOLD_MS } from './constants.ts'
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

export function positionView(p: Position, prices: Prices, now: number): PositionView {
  const mark = prices[p.marketId]?.price
  const filled = p.status === 'open' || p.status === 'closing'
  // Unrealized P&L at the mark, no spread (the server's equity does the same).
  const pnl = p.pnl ?? (filled && p.entryPrice && mark ? cents(p.notional * (p.side === 'long' ? mark / p.entryPrice - 1 : 1 - mark / p.entryPrice)) : undefined)
  const closable = p.status === 'open' && p.openedAt !== undefined ? p.openedAt + MIN_HOLD_MS : undefined
  const head = `${p.id}: ${symbolOf(p.marketId)} ${p.side} ${usd(p.notional)} at ${p.leverage}x`
  const endedBy = p.closedBy === 'liquidation' ? ' (liquidated: it lost 90 % of its margin)' : p.closedBy === 'end' ? ' (closed when the account ended)' : ''
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

// paid: the payout landed (the operator's, or the trader's own claim); review: held for an
// admin's decision; rejected: declined, never paid; unpaid: owed, the operator pays it or the
// trader claims it.
type WithdrawalState = 'paid' | 'review' | 'rejected' | 'unpaid'

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
  const state: WithdrawalState = w.paidAt !== undefined ? 'paid' : (w.status ?? 'unpaid')
  const head = `${w.id}: ${usd(w.amountUsd)} off the balance, ${coin(w.paidUsd, w.token)} to you`
  const summary =
    state === 'paid'
      ? `${head}, paid${w.tx ? ` in ${txUrl(w.tx)}` : ' (claimed from the contract)'}.`
      : state === 'review'
        ? `${head}, held for review: MonFunded screens payout wallets and an admin decides on this one before it pays.`
        : state === 'rejected'
          ? `${head}, declined after review: it will not be paid.`
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
  const summary = [`${plan} ${kind} ${c.id}${c.status === 'failed' ? `, failed on ${c.reason ? FAIL_REASON[c.reason] : 'a rule'}` : ''}: equity ${usd(p.equity)}, balance ${usd(p.balance)}.`]
  if (c.status === 'assessment') summary.push(`Profit target: ${usd(p.profit)} of ${usd(p.target)} (${pct(p.target > 0 ? (p.profit / p.target) * 100 : 0)}); it counts once no position is open.`)
  if (c.status === 'funded') summary.push(`Withdrawable now: ${usd(p.withdrawable)} (you receive ${usd(p.withdrawablePaid)}).`)
  if (c.status !== 'failed') summary.push(`Daily loss room: ${usd(dailyRoom)} (the account fails ${usd(p.dailyLimit)} below today’s opening equity; today ${signedUsd(p.dailyPnl)}).`, `Drawdown room: ${usd(p.drawdownRoom)} above the ${usd(p.drawdownFloor)} floor.`)
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
    positions,
    withdrawals,
    summary,
  }
}
