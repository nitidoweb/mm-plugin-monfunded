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
  unknownMarket: ['UNKNOWN_MARKET', 'The challenge has no such market.', 'Use one of BTC, ETH, SOL, MON, HYPE, ZEC, LIT or PUMP.'],
  marketClosed: ['MARKET_CLOSED', 'That market is not tradable right now (Perpl closed it, or its quote is stale or broken).', 'Wait a few seconds and try again, or pick another market.'],
  leverageTooHigh: ['LEVERAGE_TOO_HIGH', 'That leverage is above the cap: the plan’s crypto cap and Perpl’s own maximum for the market, whichever is lower.', 'Run `mm monfunded coach` with the same flags to see the cap.'],
  sizeTooSmall: ['SIZE_TOO_SMALL', 'Positions start at $10 of notional.', 'Pass --notional 10 or more.'],
  insufficientMargin: ['INSUFFICIENT_MARGIN', 'The position’s margin (notional ÷ leverage) is more than the account’s free margin.', 'Lower --notional, raise --leverage within the cap, or close a position first.'],
  positionNotFound: ['POSITION_NOT_FOUND', 'No pending or open position has that id on this account.', 'Run `mm monfunded status` to list open positions.'],
  holdTime: ['HOLD_TIME', 'Positions stay open at least 60 seconds after their fill.', 'Wait until the time given, then close again.'],
  entryNotVerified: ['ENTRY_NOT_VERIFIED', 'MonFunded could not verify the entry transaction: it is not mined yet, not a MonFunded entry by this wallet for this plan, or already used.', 'Wait a few seconds and repeat the same command with --entry-tx <hash>.'],
  notFunded: ['NOT_FUNDED', 'Only funded accounts can withdraw: pass the assessment first.', 'Run `mm monfunded status` to see the profit target.'],
  nothingToWithdraw: ['NOTHING_TO_WITHDRAW', 'That is more than the account’s withdrawable profit, or under the $10 minimum.', 'Run `mm monfunded status` to see what is withdrawable now.'],
  reserveLow: ['RESERVE_LOW', 'That coin’s payout reserve can’t cover this withdrawal right now.', 'Try the other coin with --token, or a smaller amount.'],
  withdrawCap: ['WITHDRAW_CAP', 'That goes over today’s withdrawal cap for this account (20 % of its size, at most $5,000 a day).', 'Withdraw less today, or wait until 00:00 UTC.'],
  invalidSignature: ['INVALID_SIGNATURE', 'MonFunded could not verify the sign-in signature (it expired after 5 minutes, or another wallet signed).', 'Run `mm monfunded login` again.'],
  underReview: ['UNDER_REVIEW', 'This payout is held for review: MonFunded screens payout wallets, and an admin decides on this one before it can be paid or claimed.', 'Nothing to do but wait; `mm monfunded status` shows when it is approved.'],
  withdrawalRejected: ['WITHDRAWAL_REJECTED', 'An admin declined this withdrawal after review: it will never be paid.', 'Ask MonFunded on Telegram (https://t.me/monfunded) if you think this is a mistake.'],
}

// The API's error as a PluginError; `retryAt` (holdTime) goes into the message.
export function apiError(status: number, code: string | undefined, retryAt?: number): PluginError {
  const known = code ? API_ERRORS[code] : undefined
  if (!known) return new PluginError('API_ERROR', `MonFunded answered HTTP ${status}${code ? ` (${code})` : ''}.`, 'Try again in a moment; if it keeps failing, tell MonFunded on Telegram (https://t.me/monfunded).')
  const [name, message, hint] = known
  if (code === 'holdTime' && retryAt !== undefined) return new PluginError(name, `${message} This one can close from ${new Date(retryAt).toISOString()}.`, hint)
  return new PluginError(name, message, hint)
}
