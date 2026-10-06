// A refusal the plugin explains in plain words: a stable code an agent can branch on, a message and
// a hint for people. The command layer (src/host.ts) turns it into mm's CommandError.
export class PluginError extends Error {
  readonly code: string
  readonly hint: string

  constructor(code: string, message: string, hint: string) {
    super(message)
    this.name = 'PluginError'
    this.code = code
    this.hint = hint
  }
}

// The MonFunded API's errors (`{ error: code }`, server/challenge-api.md) in the plugin's words.
const API_ERRORS: Record<string, [code: string, message: string, hint: string]> = {
  unauthorized: ['NOT_SIGNED_IN', 'MonFunded has no session for this wallet (never signed in, signed out, or expired after 7 days).', 'Run `mm monfunded login`.'],
  forbidden: ['FORBIDDEN', 'MonFunded refused: this wallet may not do that.', 'Check that the right wallet is active with `mm wallet address`.'],
  rateLimited: ['RATE_LIMITED', 'MonFunded is rate limiting this wallet (60 requests a minute).', 'Wait a minute, then try again.'],
  badRequest: ['BAD_REQUEST', 'MonFunded could not read the request.', 'Check the flags with `mm monfunded <command> --help`.'],
  unknownTier: ['UNKNOWN_PLAN', 'MonFunded has no such plan.', 'Run `mm monfunded status` to see the plans on sale.'],
  tierUnavailable: ['ENTRIES_CLOSED', 'That plan takes no entries right now: the plan is paused, or MonFunded’s entries are closed.', 'Run `mm monfunded status` to see whether entries are open.'],
  tooManyAssessments: ['TOO_MANY_ASSESSMENTS', 'This wallet already has the most assessments MonFunded runs at once on one wallet.', 'Pass or fail one before starting another (funded accounts do not count).'],
  fundedCap: ['FUNDED_CAP', 'This account would take the wallet past the most funded account size one wallet may hold.', 'Pick a smaller plan; `mm monfunded status` shows the funded accounts.'],
  notFound: ['NOT_FOUND', 'MonFunded has no such account or withdrawal for this wallet.', 'Run `mm monfunded status` to list your accounts and withdrawals.'],
  notActive: ['ACCOUNT_ENDED', 'That account has ended (failed), so it takes no more orders.', 'Run `mm monfunded status` to see why it ended.'],
  unknownMarket: ['UNKNOWN_MARKET', 'The challenge has no such market.', 'Use one of Perpl’s BTC, ETH, SOL, MON, HYPE, ZEC, LIT or PUMP, or a MonFunded liquidity instrument such as EURUSD, EURGBP, XAUUSD or GER30 (coach lists the markets).'],
  marketClosed: ['MARKET_CLOSED', 'That market is not tradable right now (it is closed, a MonFunded liquidity instrument is outside its hours or paused, or its quote is stale or broken).', 'Try again later, or pick another market.'],
  orderPending: ['ORDER_PENDING', 'That order is still filling: a pending order can’t be cancelled.', 'Wait a few seconds: it fills or lapses by itself.'],
  feedPaused: ['FEED_PAUSED', 'MonFunded liquidity is paused for that instrument until its price is live again (its feed reconnecting, or no fresh tick): nothing is filled or closed meanwhile.', 'Try again in a moment.'],
  leverageTooHigh: ['LEVERAGE_TOO_HIGH', 'That leverage is above the cap: the plan’s cap for the market (crypto or forex) and, on Perpl, Perpl’s own maximum for it, whichever is lower.', 'Run `mm monfunded coach` with the same flags to see the cap.'],
  orderTooLarge: ['ORDER_TOO_LARGE', 'That forex order is over the most one order may be (MonFunded liquidity’s cap, $5,000,000 by default).', 'Lower --notional.'],
  pairTooLarge: ['PAIR_TOO_LARGE', 'The account’s positions in that forex pair would pass the cap for one pair together ($5,000,000 by default).', 'Lower --notional, or close a position in the pair first.'],
  sizeTooSmall: ['SIZE_TOO_SMALL', 'Positions start at $10 of notional.', 'Pass --notional 10 or more.'],
  insufficientMargin: ['INSUFFICIENT_MARGIN', 'The position’s margin (notional ÷ leverage) is more than the account’s free margin.', 'Lower --notional, raise --leverage within the cap, or close a position first.'],
  positionNotFound: ['POSITION_NOT_FOUND', 'No pending or open position has that id on this account.', 'Run `mm monfunded status` to list open positions.'],
  hedging: ['HEDGING', 'The account already holds the other side of that market, and MonFunded takes one side of a market at a time.', 'Close the position on the other side first.'],
  crossHedge: ['CROSS_HEDGE', 'Another account of this wallet holds the other side of that market, and MonFunded refuses opposite sides across a wallet’s own accounts.', 'Close the position (or cancel the order) on the other account first.'],
  newsPause: ['NEWS_PAUSE', 'This account’s own news pause is on, and a high-impact release for that market is within five minutes.', 'Try again after the time given; the pause is switched off in the MonFunded dashboard.'],
  guardFired: ['GUARD_FIRED', 'This account’s equity guard has fired and is closing its positions, so it takes no new order.', 'Set the guard again in the MonFunded dashboard before trading on.'],
  lotSize: ['LOT_SIZE', 'That size is outside the instrument’s lot range (its smallest lot, its step or its largest).', 'Raise or lower --notional; MonFunded liquidity trades in whole lot steps.'],
  holdTime: ['HOLD_TIME', 'Positions stay open at least 60 seconds after their fill.', 'Wait until the time given, then close again.'],
  entryNotVerified: ['ENTRY_NOT_VERIFIED', 'MonFunded could not verify the entry transaction: it is not mined yet, not a MonFunded entry by this wallet for this plan, or already used.', 'Wait a few seconds and repeat the same command with --entry-tx <hash>.'],
  entryUnderpaid: ['ENTRY_UNDERPAID', 'The entry paid less than the plan costs now (MonFunded changed the plan’s price after this payment), so it can’t start the account.', 'Don’t pay again: open a support ticket in the MonFunded dashboard (https://monfunded.com/app/#support) with the entry transaction.'],
  entryExpired: ['ENTRY_EXPIRED', 'The entry transaction is too old: MonFunded registers entries paid in the last 3 days only.', 'Open a support ticket in the MonFunded dashboard (https://monfunded.com/app/#support) with the entry transaction.'],
  orderLimit: ['ORDER_LIMIT', 'This account has placed the most orders MonFunded takes from one account in a UTC day.', 'Wait until 00:00 UTC, when the count starts again; positions already open keep running.'],
  notFunded: ['NOT_FUNDED', 'Only funded accounts can withdraw: pass the assessment first.', 'Run `mm monfunded status` to see the profit target.'],
  nothingToWithdraw: ['NOTHING_TO_WITHDRAW', 'The account’s profit is under the $10 minimum right now.', 'Run `mm monfunded status` to see what is withdrawable now.'],
  reserveLow: ['RESERVE_LOW', 'That coin’s payout reserve can’t cover this payout right now.', 'Try the other coin with --token, or again later.'],
  positionsOpen: ['POSITIONS_OPEN', 'A payout takes the whole profit, so the account must be flat first: this one still has a live position.', 'Close every position, then run `mm monfunded withdraw` again.'],
  payoutPending: ['PAYOUT_PENDING', 'This account has a payout waiting on a decision (released or declined): until then it takes no new order and no other payout.', 'Run `mm monfunded status` to see it; wait for it to be released or declined.'],
  claimThrottled: ['CLAIM_THROTTLED', 'MonFunded was asked for this payout’s claim too often in a short time.', 'Wait a minute, then run the same command again.'],
  unavailable: ['UNAVAILABLE', 'MonFunded can’t do that right now (the server is starting, or a part of it is down).', 'Try again in a minute.'],
  invalidSignature: ['INVALID_SIGNATURE', 'MonFunded could not verify the sign-in signature (it expired after 5 minutes, or another wallet signed).', 'Run `mm monfunded login` again.'],
  underReview: ['UNDER_REVIEW', 'This payout is held for review: MonFunded checks every payout, and a person decides on this one before it can be paid or claimed.', 'Nothing to do but wait; `mm monfunded status` shows when it is approved.'],
  withdrawalRejected: ['WITHDRAWAL_REJECTED', 'An admin declined this withdrawal after review: it will never be paid.', 'Open a support ticket in the MonFunded dashboard (https://monfunded.com/app/#support) if you think this is a mistake.'],
}

// What an error reply may carry besides its code (server/challenge-api.md): holdTime and
// orderLimit say when to retry, orderLimit the day's limit, entryUnderpaid what was paid and what
// the plan costs, entryExpired the oldest entry it takes, the wallet's limits their numbers, a
// hedge the side or the account in the way, and the news pause when it ends.
export type ErrorExtras = { retryAt?: unknown; limit?: unknown; paidUsd?: unknown; feeUsd?: unknown; maxAgeHours?: unknown; max?: unknown; held?: unknown; account?: unknown; until?: unknown }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
// A time in milliseconds as a date, when it is one a Date can hold.
const when = (v: unknown) => {
  const ms = num(v)
  return ms !== undefined && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined
}
const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// The details an error's extras add to its message, each only when the server sent it well formed.
function details(code: string, extra: ErrorExtras): string {
  const at = when(extra.retryAt)
  if (code === 'holdTime' && at) return ` This one can close from ${at}.`
  if (code === 'orderLimit') {
    const limit = num(extra.limit)
    return `${limit !== undefined ? ` The limit is ${limit} orders a day.` : ''}${at ? ` The next order is taken from ${at}.` : ''}`
  }
  if (code === 'entryUnderpaid') {
    const [paid, fee] = [num(extra.paidUsd), num(extra.feeUsd)]
    return paid !== undefined && fee !== undefined ? ` It paid ${dollars(paid)}; the plan costs ${dollars(fee)}.` : ''
  }
  if (code === 'tooManyAssessments') {
    const max = num(extra.max)
    return max !== undefined ? ` The limit is ${max} at a time.` : ''
  }
  if (code === 'fundedCap') {
    const [max, held] = [num(extra.max), num(extra.held)]
    return max !== undefined && held !== undefined ? ` It holds ${dollars(held)}; the most is ${dollars(max)}.` : ''
  }
  if (code === 'hedging') return extra.held === 'long' || extra.held === 'short' ? ` It is ${extra.held} there.` : ''
  if (code === 'crossHedge') return typeof extra.account === 'string' && /^0x[0-9a-f]{1,64}$/i.test(extra.account) ? ` The other account is ${extra.account}.` : ''
  if (code === 'newsPause') {
    const until = when(extra.until)
    return until ? ` Orders are taken again from ${until}.` : ''
  }
  if (code === 'entryExpired') {
    const hours = num(extra.maxAgeHours)
    return hours !== undefined ? ` The oldest entry MonFunded takes is ${hours} hours old.` : ''
  }
  return ''
}

// The API's error as a PluginError, with what its extras say (when to retry, the amounts).
export function apiError(status: number, code: string | undefined, extra: ErrorExtras = {}): PluginError {
  const known = code ? API_ERRORS[code] : undefined
  if (!known || !code) return new PluginError('API_ERROR', `MonFunded answered HTTP ${status}${code ? ` (${code})` : ''}.`, 'Try again in a moment; if it keeps failing, open a support ticket in the MonFunded dashboard (https://monfunded.com/app/#support).')
  const [name, message, hint] = known
  return new PluginError(name, `${message}${details(code, extra)}`, hint)
}
