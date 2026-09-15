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
  tierUnavailable: ['ENTRIES_CLOSED', 'That plan takes no entries right now: the MonFunded contract is not deployed yet, or the plan is paused.', 'Run `mm monfunded status` to see whether entries are open.'],
  alreadyActive: ['ALREADY_ACTIVE', 'This wallet already has an assessment running, and MonFunded allows one at a time.', 'Pass or fail the running assessment before buying another (funded accounts do not count).'],
  notFound: ['NOT_FOUND', 'MonFunded has no such account or withdrawal for this wallet.', 'Run `mm monfunded status` to list your accounts and withdrawals.'],
  notActive: ['ACCOUNT_ENDED', 'That account has ended (failed), so it takes no more orders.', 'Run `mm monfunded status` to see why it ended.'],
  unknownMarket: ['UNKNOWN_MARKET', 'The challenge has no such market.', 'Use one of Perpl’s BTC, ETH, SOL, MON, HYPE, ZEC, LIT or PUMP, or a MonFunded liquidity instrument such as EURUSD, EURGBP, XAUUSD or GER30 (coach lists the markets).'],
  marketClosed: ['MARKET_CLOSED', 'That market is not tradable right now (it is closed, a MonFunded liquidity instrument is outside its hours or paused, or its quote is stale or broken).', 'Try again later, or pick another market.'],
  orderPending: ['ORDER_PENDING', 'That order is still filling: a pending order can’t be cancelled.', 'Wait a few seconds: it fills or lapses by itself.'],
  feedPaused: ['FEED_PAUSED', 'MonFunded liquidity is paused for that instrument until its price is live again (its feed reconnecting, or no fresh tick): nothing is filled or closed meanwhile.', 'Try again in a moment.'],
  noFreshQuote: ['NO_FRESH_QUOTE', 'That forex pair has had no live price in the last 3 seconds, and MonFunded liquidity closes a position only on a live one.', 'Try again in a moment.'],
  leverageTooHigh: ['LEVERAGE_TOO_HIGH', 'That leverage is above the cap: the plan’s cap for the market (crypto or forex) and, on Perpl, Perpl’s own maximum for it, whichever is lower.', 'Run `mm monfunded coach` with the same flags to see the cap.'],
  orderTooLarge: ['ORDER_TOO_LARGE', 'That forex order is over the most one order may be (MonFunded liquidity’s cap, $5,000,000 by default).', 'Lower --notional.'],
  pairTooLarge: ['PAIR_TOO_LARGE', 'The account’s positions in that forex pair would pass the cap for one pair together ($5,000,000 by default).', 'Lower --notional, or close a position in the pair first.'],
  sizeTooSmall: ['SIZE_TOO_SMALL', 'Positions start at $10 of notional.', 'Pass --notional 10 or more.'],
  insufficientMargin: ['INSUFFICIENT_MARGIN', 'The position’s margin (notional ÷ leverage) is more than the account’s free margin.', 'Lower --notional, raise --leverage within the cap, or close a position first.'],
  positionNotFound: ['POSITION_NOT_FOUND', 'No pending or open position has that id on this account.', 'Run `mm monfunded status` to list open positions.'],
  holdTime: ['HOLD_TIME', 'Positions stay open at least 60 seconds after their fill.', 'Wait until the time given, then close again.'],
  entryNotVerified: ['ENTRY_NOT_VERIFIED', 'MonFunded could not verify the entry transaction: it is not mined yet, not a MonFunded entry by this wallet for this plan, or already used.', 'Wait a few seconds and repeat the same command with --entry-tx <hash>.'],
  entryUnderpaid: ['ENTRY_UNDERPAID', 'The entry paid less than the plan costs now (MonFunded changed the plan’s price after this payment), so it can’t start the account.', 'Don’t pay again: tell MonFunded on Telegram (https://t.me/monfunded) with the entry transaction.'],
  entryExpired: ['ENTRY_EXPIRED', 'The entry transaction is too old: MonFunded registers entries paid in the last 3 days only.', 'Tell MonFunded on Telegram (https://t.me/monfunded) with the entry transaction.'],
  orderLimit: ['ORDER_LIMIT', 'This account has placed the most orders MonFunded takes from one account in a UTC day.', 'Wait until 00:00 UTC, when the count starts again; positions already open keep running.'],
  notFunded: ['NOT_FUNDED', 'Only funded accounts can withdraw: pass the assessment first.', 'Run `mm monfunded status` to see the profit target.'],
  nothingToWithdraw: ['NOTHING_TO_WITHDRAW', 'That is more than the account’s withdrawable profit, or under the $10 minimum.', 'Run `mm monfunded status` to see what is withdrawable now.'],
  reserveLow: ['RESERVE_LOW', 'That coin’s payout reserve can’t cover this withdrawal right now.', 'Try the other coin with --token, or a smaller amount.'],
  withdrawCap: ['WITHDRAW_CAP', 'That goes over today’s withdrawal cap for this account (20 % of its size, at most $5,000 a day).', 'Withdraw less today, or wait until 00:00 UTC.'],
  invalidSignature: ['INVALID_SIGNATURE', 'MonFunded could not verify the sign-in signature (it expired after 5 minutes, or another wallet signed).', 'Run `mm monfunded login` again.'],
  underReview: ['UNDER_REVIEW', 'This payout is held for review: MonFunded screens payout wallets, and an admin decides on this one before it can be paid or claimed.', 'Nothing to do but wait; `mm monfunded status` shows when it is approved.'],
  withdrawalRejected: ['WITHDRAWAL_REJECTED', 'An admin declined this withdrawal after review: it will never be paid.', 'Ask MonFunded on Telegram (https://t.me/monfunded) if you think this is a mistake.'],
}

// What an error reply may carry besides its code (server/challenge-api.md): holdTime and
// orderLimit say when to retry, orderLimit the day's limit, entryUnderpaid what was paid and what
// the plan costs, entryExpired the oldest entry it takes.
export type ErrorExtras = { retryAt?: unknown; limit?: unknown; paidUsd?: unknown; feeUsd?: unknown; maxAgeHours?: unknown }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// The details an error's extras add to its message, each only when the server sent it well formed.
function details(code: string, extra: ErrorExtras): string {
  const retryAt = num(extra.retryAt)
  const at = retryAt !== undefined ? new Date(retryAt).toISOString() : undefined
  if (code === 'holdTime' && at) return ` This one can close from ${at}.`
  if (code === 'orderLimit') {
    const limit = num(extra.limit)
    return `${limit !== undefined ? ` The limit is ${limit} orders a day.` : ''}${at ? ` The next order is taken from ${at}.` : ''}`
  }
  if (code === 'entryUnderpaid') {
    const [paid, fee] = [num(extra.paidUsd), num(extra.feeUsd)]
    return paid !== undefined && fee !== undefined ? ` It paid ${dollars(paid)}; the plan costs ${dollars(fee)}.` : ''
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
  if (!known || !code) return new PluginError('API_ERROR', `MonFunded answered HTTP ${status}${code ? ` (${code})` : ''}.`, 'Try again in a moment; if it keeps failing, tell MonFunded on Telegram (https://t.me/monfunded).')
  const [name, message, hint] = known
  return new PluginError(name, `${message}${details(code, extra)}`, hint)
}
