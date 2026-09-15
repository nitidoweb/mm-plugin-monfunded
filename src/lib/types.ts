// The parts of the MonFunded API's shapes the plugin reads (the full ones are src/lib/challenge.ts
// in the MonFunded repository; server/challenge-api.md describes every route).

export type Address = `0x${string}`
export type Hex = `0x${string}`

export type Risk = 'tight' | 'medium'
export type PayoutToken = 'USDC' | 'AUSD'
export type PayWith = PayoutToken | 'MON'
export type Side = 'long' | 'short'

export type Rules = {
  size: number
  dailyLossPct: number
  maxDrawdownPct: number
  profitTargetPct: number
  leverage: Record<string, number>
}

export type Tier = {
  id: string
  index: number
  risk: Risk
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
  closedBy?: 'trader' | 'liquidation' | 'end'
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
}

export type Withdrawal = {
  id: string
  amountUsd: number
  paidUsd: number
  token: PayoutToken
  status?: 'review' | 'rejected'
  requestedAt: number
  tx?: Hex
  paidAt?: number
}

export type ChallengeStatus = 'assessment' | 'funded' | 'failed'

export type Challenge = {
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
