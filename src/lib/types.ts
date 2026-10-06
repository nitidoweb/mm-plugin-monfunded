// The parts of the MonFunded API's shapes the plugin reads (the full ones are src/lib/challenge.ts
// in the MonFunded repository; server/challenge-api.md describes every route).

export type Address = `0x${string}`
export type Hex = `0x${string}`

export type PayoutToken = 'USDC' | 'AUSD'
export type PayWith = PayoutToken | 'MON'
export type Side = 'long' | 'short'

export type Rules = {
  size: number
  dailyLossPct: number
  maxDrawdownPct: number
  profitTargetPct: number
  leverage: Record<string, number>
  // The most one UTC day may be worth, as a share of the phase's profit (absent on old accounts).
  consistencyPct?: number
}

export type Tier = {
  id: string
  index: number
  size: number
  feeUsd: number
  rules: Rules
  name?: string
  enabled?: boolean
}

export type ChallengeConfig = {
  tiers: Tier[]
  profitSplitPct: number
  minWithdrawUsd: number
  contract: Address | null
  usdc: Address
  ausd: Address
  monMarket: Address | null
  reserveUsd: number | null
  reserves: Record<PayoutToken, number | null>
}

export type PositionStatus = 'pending' | 'open' | 'closing' | 'closed' | 'cancelled'

export type Position = {
  id: string
  marketId: string
  side: Side
  status: PositionStatus
  notional: number
  leverage: number
  margin: number
  requestedAt: number
  entryPrice?: number
  openedAt?: number
  exitPrice?: number
  closedAt?: number
  pnl?: number
  closedBy?: 'trader' | 'liquidation' | 'stopOut' | 'end' | 'guard' | 'sl' | 'tp'
}

export type RuleProgress = {
  equity: number
  balance: number
  dailyPnl: number
  dailyLimit: number
  drawdownRoom: number
  drawdownFloor: number
  profit: number
  target: number
  withdrawable: number
  withdrawablePaid: number
  // The consistency rule as it stands: the phase's best UTC day, its profit, the day's share of it,
  // the limit, whether it is inside it, and the profit that would bring it inside.
  consistency?: { bestDay: number; profit: number; sharePct: number; limitPct: number; ok: boolean; need: number }
  // Margin in use at current prices, free margin, and the level in % (null: nothing uses margin).
  margin?: { used: number; free: number; level: number | null; call: boolean }
}

export type Withdrawal = {
  id: string
  amountUsd: number
  paidUsd: number
  token: PayoutToken
  status?: 'review' | 'rejected' | 'queued'
  requestedAt: number
  tx?: Hex
  paidAt?: number
}

export type ChallengeStatus = 'assessment' | 'funded' | 'failed'

export type Challenge = {
  // A practice account: nothing was paid for it and it pays nothing out.
  demo?: true
  id: string
  trader: Address
  tier: string
  status: ChallengeStatus
  reason?: 'dailyLoss' | 'maxDrawdown' | 'conduct'
  startedAt: number
  fundedAt?: number
  endedAt?: number
  balance: number
  rules: Rules
  positions: Position[]
  progress: RuleProgress
  trades: number
  withdrawals: Withdrawal[]
  entryTx: Hex
  // One of its positions has no live price: no order, withdrawal or claim until it does.
  frozen?: true
  // A payout is waiting on a decision: no new order until it is released or declined.
  payoutPending?: true
}

export type Me = { address: Address; active: Challenge[]; past: Challenge[] }

export type Quote = {
  price: number
  updatedAt: number
  tradable: boolean
  bid?: number
  ask?: number
  maxLeverage?: number
}

export type Prices = Record<string, Quote>

export type ClaimProof = { signature: Hex; logRoot: Hex; token: PayoutToken }
