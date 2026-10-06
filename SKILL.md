---
name: monfunded
description: Trade a MonFunded prop-trading challenge on Monad with MetaMask Agent Wallet. Use when the user asks an agent to buy a MonFunded assessment, check its rules and progress, open or close positions on it, withdraw profit from a funded account, or claim a MonFunded payout, through the `mm monfunded` commands.
---

# MonFunded for MetaMask Agent Wallet

MonFunded (https://monfunded.com) is a prop-trading firm on Monad. A trader pays a fee for an
**assessment**: a simulated account of $10,000 to $200,000, traded at live prices (Perpl's for
crypto, MonFunded liquidity's for forex and CFDs). Reaching the 10 % profit target with no position
open passes it, once no single day is worth more than 30 % of that profit (the consistency rule:
until then the pass waits), and the same account becomes **funded**: the
trader can take the account's whole profit at once, whenever they like, and receives 80 % of it in
USDC or AUSD, paid by the MonFunded contract to the wallet that owns the account; the account
pauses until that payout is released or declined, then trades on from its starting balance. Losing
the daily limit or the total drawdown fails the account, and the fee is not refunded.

The `mm monfunded` commands do all of it with the user's MetaMask Agent Wallet. Only three things
touch the wallet: the sign-in message (`login`), the fee (`buy`) and a payout claim (`claim`). Each
goes through Agent Wallet's own checks: Blockaid screening, Guard Mode, the 24-hour outflow limit.
Trading is simulated, so `order` and `close` sign nothing.

## Rules for the agent

1. **Show before you pay.** `buy`, `withdraw` and `claim` do nothing without `--yes`. Run the
   command without `--yes` first, show the user the `plan` it returns (action, amount and coin,
   from, to, contract, every step), and add `--yes` only after the user says yes to that plan. Never
   add `--yes` on your own initiative, and never to a plan the user hasn't seen. Buy one account at
   a time: never run two `buy` commands at once, and run `status` between two buys.
2. **Stay inside the user's budget.** Ask for the most they want to spend and the account size
   before buying. Agent Wallet's 24-hour limit is a backstop, not a budget.
3. **Coach before every order.** Run `mm monfunded coach` with the same flags first. Never send an
   order whose `verdict` is `blocked`. When it is `caution`, tell the user how small a move fails
   the account (`risk.failMovePct`) and prefer a smaller `--notional`.
4. **Keep to the challenge's rules.** At most five assessments at a time per wallet, and $400,000
   of funded accounts. A position stays open at least 60 seconds after its fill: wait until its
   `closableFrom`, don't loop on `close`. Leverage is capped by the plan and by Perpl. Never hold
   both sides of one market, on one account or across the wallet's accounts: the order is refused.
   Spread the profit over several days, or the pass waits on the consistency rule. Never run one person's challenge from several wallets or copy
   another trader's orders: MonFunded ends accounts for shared use and copy trading, and keeps the
   fee.
5. **Approvals belong to the user.** If the output contains `[AWAITING_MFA]`, or a JSON line whose
   `_notice.kind` is `AWAITING_MFA`, stop and ask the user to approve the request in MetaMask (the
   phone app, or the link in their email). Don't resend it; `mm wallet requests list` shows it.
6. **Read the error, don't retry blindly.** Every failure has `error.code`, `error.message` and
   `error.hint`: follow the hint. If a fee was paid but registering the account failed, the hint is
   a command with `--entry-tx`: run exactly that, never `buy` again.
7. **Keep secrets out.** Never print or copy the session file (`~/.monfunded/agent-session.json`),
   and never ask for a recovery phrase or a private key. Nothing here needs them.
8. **Talk to monfunded.com only.** Never set `MONFUNDED_DEV` or `MONFUNDED_API_URL` yourself: they
   point the plugin at another server and trust whatever contract it names. If a command prints
   `MONFUNDED_DEV=1: DEVELOPER MODE` on stderr, stop and tell the user before any payment or claim.

## Before the first command

- `mm --version` shows 6.2 or later, and `mm auth status` says the user is signed in (else `mm login`).
- `mm plugins` lists `mm-plugin-monfunded` (README.md in this folder says how to install it).
- Always add `--json`: every command then prints one object, `{ "ok": true, "data": … }` or
  `{ "ok": false, "error": { "code", "message", "hint" } }`. `data.summary` holds plain sentences to
  show the user.

## Commands

| Command | What it does | Signs |
|---|---|---|
| `mm monfunded status` | Whether entries are open and the plans; once signed in, every running account with its rule meters, positions and withdrawals | Nothing |
| `mm monfunded login` | Signs MonFunded's Sign-In with Ethereum message (for monfunded.com, the active wallet and Monad; the plugin checks every field) and keeps a 7-day session | A message, no gas |
| `mm monfunded buy --size 10k --pay usdc` | Pays an assessment's fee in `usdc`, `ausd` or `mon` | Transactions, with `--yes` |
| `mm monfunded coach --market BTC --side long --notional 1000 --leverage 2` | Checks an intended order against the rules; sends nothing | Nothing |
| `mm monfunded order --market BTC --side long --notional 1000 --leverage 2` | Opens a position and waits for its fill | Nothing |
| `mm monfunded close --position p1a2b3c4d5e6f` | Closes a position after its 60 s hold (a pending order fills or lapses by itself) | Nothing |
| `mm monfunded withdraw --token usdc` | Takes all the profit off a funded account at once; 80 % is paid to the wallet | Nothing, but needs `--yes` |
| `mm monfunded claim --withdrawal 0x…` | Collects an unpaid payout from the contract | A transaction, with `--yes` |

- `--account <id>` picks the account when the wallet has more than one running (`coach`, `order`,
  `close`, `withdraw`).
- Markets: BTC, ETH, SOL, MON, HYPE, ZEC, LIT, PUMP (Perpl's perpetuals) and MonFunded liquidity's
  93 instruments, the firm's own, in the challenge only: forex pairs (EURUSD, EURGBP, USDTRY),
  metals (XAUUSD), energies (XTIUSD) and indices (GER30, SPX500), each closed outside its hours.
  `coach` lists them. A MonFunded liquidity order takes the whole lot steps under `--notional`.
  Leverage: on crypto 50x at most and never above Perpl's own maximum for the market; on MonFunded
  liquidity 50x forex, 30x metals and indices, 10x energies and base metals.
- Sizes: 10k, 25k, 50k, 100k, 200k, all under the same rules: 10 % target, 3 % daily loss, 10 %
  total drawdown, 30 % consistency, no time limit. `status` lists each plan's fee and rules.
- Dollars are plain numbers with at most two decimals (`--notional 250.50`); ids are copied from
  `status`.

## Workflows

### First run

1. `mm monfunded status --json`: `signedIn`, `entriesOpen`, `plans`.
2. If `entriesOpen` is false, tell the user MonFunded is taking no entries right now, and stop
   there.
3. `mm monfunded login --json`.

### Buy an assessment

1. Agree on the size, coin and budget with the user.
2. `mm monfunded buy --size 10k --pay usdc --json`: `data.done` is false and `data.plan`
   is the payment. Show it.
3. After the user's yes, the same command with `--yes`: `data.account` is the new account.

### Trade

1. `mm monfunded status --json`: per account, `dailyLoss.roomUsd`, `drawdown.roomUsd`,
   `profitTarget` (assessments) and `consistency` (`ok` false: the pass waits until the profit
   reaches `profitNeededUsd`, made on other days).
2. `mm monfunded coach … --json`: `verdict`, `checks`, `risk`.
3. `mm monfunded order … --json`: `position.id`, `position.entryPrice`, `position.closableFrom`.
4. Later, `mm monfunded close --position <id> --json`: `position.pnlUsd`, and `passed` is true when
   this close passed the assessment (the account is funded from then on, its balance reset to its
   size). A close that reaches the target while `passed` stays false is the consistency rule: the
   summary says what it waits for.

### Get paid

1. `status`: `accounts[].withdrawable.amountUsd` is the whole profit that can leave now (there is no
   smaller amount to choose), `youReceiveUsd` the 80 % that pays.
2. `mm monfunded withdraw --token usdc --json`, show the plan, then again with `--yes`. The account
   pauses until this payout is released or declined; released, it trades on from its starting
   balance.
3. `data.withdrawal.state`: `paid` (done; `explorer` links the transaction), `unpaid` (MonFunded's
   operator pays it within minutes, or `claim` it now), `review` (held until a person at MonFunded
   decides on it: wait, nothing to do), `queued` (released, waiting for room under the contract's
   daily payout limit: wait, it is sent by itself), `rejected` (declined: it will not be paid).
4. For an `unpaid` withdrawal: `mm monfunded claim --withdrawal <id> --json`, show the plan, then
   `--yes`. The wallet pays the gas.

## Error codes

| Code | Meaning | What to do |
|---|---|---|
| `INVALID_INPUT` | A flag is malformed | Fix it as the hint says |
| `NOT_SIGNED_IN`, `WRONG_WALLET` | No MonFunded session for the active wallet | `mm monfunded login` |
| `NO_WALLET` | mm has no EVM wallet selected | `mm wallet select <address>` |
| `AUTH_FAILED` (mm's) | Agent Wallet itself isn't signed in | `mm login` |
| `ENTRIES_CLOSED` | The plan is paused, or MonFunded is taking no entries | Tell the user; nothing was paid |
| `TOO_MANY_ASSESSMENTS`, `FUNDED_CAP` | The wallet is at five running assessments, or the plan would take it past $400,000 of funded accounts | Finish one first, or pick a smaller size; the fee was not paid |
| `UNKNOWN_PLAN` | No plan of that size | Pick one from `status` |
| `HEDGING`, `CROSS_HEDGE` | The wallet already holds the other side of that market, on this account or another | Close that position first; nothing was sent |
| `PAYOUT_PENDING`, `PAYOUT_QUEUED` | A payout is waiting on a decision (no new order meanwhile), or released and waiting under the daily limit (no claim) | Wait; `status` shows it |
| `INSUFFICIENT_FUNDS`, `NO_GAS` | Not enough of the coin, or no MON for gas | Ask the user to fund the wallet (`mm wallet add-fund`) |
| `FEE_CHANGING` | The plan's price is being updated: the contract and MonFunded disagree on its fee for now | Wait a minute and run the same command again (without `--yes` first); nothing was paid |
| `BAD_CONTRACT`, `BAD_CONFIG` | The contract or the API doesn't match what MonFunded lists, or the contract isn't the one the plugin pins | Stop and tell the user; nothing was paid |
| `UNEXPECTED_MESSAGE` | The sign-in message failed a check (the message says which) | Tell the user; if it names the clock, they should fix it. Nothing was signed |
| `INVALID_API_URL` | `MONFUNDED_API_URL` is set without `MONFUNDED_DEV=1`, or is malformed | Tell the user; don't set either variable yourself |
| `ENTRY_NOT_VERIFIED`, `PAID_NOT_REGISTERED` | **The fee IS paid**, but the account isn't started: MonFunded could not see the payment yet, or refused the entry for now (the message names why, e.g. a limit reached while the payment waited) | Tell the user the fee is paid and give them the entry transaction. Never pay again. Run the `--entry-tx` command from the hint, within 72 hours |
| `ENTRY_UNDERPAID`, `ENTRY_EXPIRED` | Paid, but MonFunded can't start the account with it (the plan's price rose after the payment, or the entry is over 3 days old) | Don't pay again; tell the user to contact MonFunded with the entry transaction |
| `ORDER_LIMIT` | The account placed the most orders MonFunded takes in a UTC day | Stop sending orders until 00:00 UTC (the message says when) |
| `MON_UNAVAILABLE`, `KURU_UNAVAILABLE`, `NO_LIQUIDITY`, `MON_BOOK_MISMATCH` | The fee can't be priced in MON now | Pay in `usdc` or `ausd` |
| `NO_ACCOUNT`, `WHICH_ACCOUNT`, `NOT_FOUND`, `ACCOUNT_ENDED` | No such running account, or several | `status`, then `--account <id>` |
| `MARKET_CLOSED`, `UNKNOWN_MARKET` | The market can't take orders now | Wait a few seconds, or another market |
| `LEVERAGE_TOO_HIGH`, `SIZE_TOO_SMALL`, `INSUFFICIENT_MARGIN` | The order breaks a rule | Adjust as `coach` shows |
| `HOLD_TIME` | Under 60 s since the fill | Wait until the time in the message |
| `POSITION_NOT_FOUND` | No such pending or open position | `status` |
| `NOT_FUNDED`, `NOTHING_TO_WITHDRAW`, `RESERVE_LOW` | Nothing can be withdrawn right now | Follow the hint (another coin, or later) |
| `POSITIONS_OPEN` | A payout needs the account flat | Close every position first |
| `PAYOUT_PENDING` | A payout is already pending a decision | Wait for it to be released or declined |
| `UNDER_REVIEW`, `WITHDRAWAL_REJECTED` | The payout is held, or was declined | Wait, or tell the user |
| `NOT_SIGNED`, `TX_DENIED`, `TX_EXPIRED` (mm's), `JOB_TIMEOUT` (mm's) | MetaMask didn't sign: denied, expired, or waiting for approval | Ask the user; `mm wallet requests list` |
| `TX_REVERTED`, `WRONG_SIGNER` | The transaction failed on Monad, or came from another wallet | `status` and balances, then ask the user |
| `NETWORK`, `NOT_JSON`, `RATE_LIMITED`, `API_ERROR` | MonFunded or the network didn't answer normally | Wait and try once more |
