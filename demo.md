# Demo: an AI agent runs a MonFunded challenge with MetaMask Agent Wallet

There are three ways to see it:

1. Locally, with nothing real. You only need this repository, and it takes about a minute.
2. The real thing, with MetaMask Agent Wallet on monfunded.com.
3. The same through an AI agent.

## 1. The whole flow locally, with nothing real (one command)

From the repository root:

```sh
npm install
cd agent && npm install
npm run test:e2e
```

The test runs three pieces:

- MonFunded's own server, on http://127.0.0.1:4417.
- The real MonFunded contract (`contracts/out`), in an in-memory Monad.
- The plugin's code for every command, with a stand-in for MetaMask that signs with a throwaway
  key.

The plugin reaches the local server in developer mode (`MONFUNDED_DEV=1` with `MONFUNDED_API_URL`),
the only way it talks to anything but monfunded.com, so it prints the developer-mode warning first
and trusts the local contract instead of the one it pins. It prints each step as the terminal
session it stands for, and it checks the chain after every payment. Here is one run (ids,
addresses and times change every time):

```text
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
MONFUNDED_DEV=1: DEVELOPER MODE. The plugin talks to http://127.0.0.1:4417, not https://monfunded.com,
and trusts that server as it is: whatever contract and MON book it names get paid.
Use it only with a test server and test funds, never with real money.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
MonFunded agent plugin, end to end: in-memory Monad (contract 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f), MonFunded server on http://127.0.0.1:4417, MetaMask stand-in for 0x13f73e11397411136dbB74ea8f76A7eb10e47AbB.

$ mm monfunded status
  Not signed in to MonFunded (http://127.0.0.1:4417).
  Run `mm monfunded login` to sign in with the active wallet.
  Entries are open: fees go to the MonFunded contract 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f on Monad.
  5 plans on sale, from $89.00.

$ mm monfunded login
  Signed in to MonFunded (http://127.0.0.1:4417) as 0x13f73e11397411136dbB74ea8f76A7eb10e47AbB until 2026-10-13T12:30:49.792Z.
  The session is kept in /tmp/monfunded-agent-e2e-FpOTXt/agent/agent-session.json, readable by this user only.
  No account yet: see the plans with `mm monfunded status`, then `mm monfunded buy`.

$ mm monfunded buy --size 10k --pay usdc
  Buy the $10,000 assessment (plan plan-10000)
    Amount:   89.00 USDC
    From:     0x13f73e11397411136dbB74ea8f76A7eb10e47AbB
    To:       the MonFunded contract 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f
    Contract: 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f
    Chain:    Monad (chain 143)
    Step 1:   approve(0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f, 89000000) on USDC (0x754704Bc059F8C67012fEd69BC8A327a5aafb603): lets the contract take exactly the fee, nothing more.
    Step 2:   enter(0) on 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f: moves 89.00 USDC into the contract’s USDC reserve and starts the account.
    Note:     Rules: close positions at 10 % profit to pass; losing 3 % in a day or 10 % in total fails the account.
    Note:     Consistency: no single day may be worth more than 30 % of the profit; until then the pass waits.
    Note:     The fee is not refundable once the account is active.
  Nothing was signed or paid. Run the same command again with --yes to sign and pay.

$ mm monfunded buy --size 10k --pay usdc --yes
  Paid in https://monadscan.com/tx/0xcb836d6b0161385b8021e5ff44b1b05220a03fa32b7dcf421b75831b4e881905.
  $10,000 assessment 0x1cce310ae7d91265f4d95d8453c99969a01330b0bec2c7c119b0e16a93a74b4e: equity $10,000.00, balance $10,000.00.
  Profit target: $0.00 of $1,000.00 (0 %); it counts once no position is open.
  Daily loss room: $300.00 (the account fails $300.00 below today’s opening equity; today $0.00).
  Drawdown room: $1,000.00 above the $9,000.00 floor.

# Chain: the trader holds 911 USDC; the contract’s USDC reserve holds 589.

$ mm monfunded coach --market BTC --side long --notional 40000 --leverage 5
  A 0.75 % move against you (BTC down to about 59551) fails the account on its daily loss limit.
  It locks $8,000.00 of margin and leaves the account’s margin level at 125 %: at 100 % the account shows a margin call, and at 50 % the server closes its largest losing position.
  It fills at the next Perpl quote, near 60000.5 (the ask), and must stay open 60 s before it can be closed.
  Opening and closing costs about $0.67 in spread.
  Caution: a move under 1 % is an ordinary one. A smaller --notional leaves more room.

$ mm monfunded coach --market BTC --side long --notional 5000 --leverage 16
  MonFunded would refuse this order: 16x is above the 15x cap on BTC (the plan allows 50x, Perpl 15x). Pass --leverage 15 or less.
  A 6 % move against you (BTC down to about 56401) fails the account on its daily loss limit.
  It locks $312.50 of margin and leaves the account’s margin level at 3,199.99 %: at 100 % the account shows a margin call, and at 50 % the server closes its largest losing position.
  It fills at the next Perpl quote, near 60000.5 (the ask), and must stay open 60 s before it can be closed.
  Opening and closing costs about $0.08 in spread.

$ mm monfunded coach --market BTC --side long --notional 5000 --leverage 2
  A 6 % move against you (BTC down to about 56401) fails the account on its daily loss limit.
  It locks $2,500.00 of margin and leaves the account’s margin level at 400 %: at 100 % the account shows a margin call, and at 50 % the server closes its largest losing position.
  It fills at the next Perpl quote, near 60000.5 (the ask), and must stay open 60 s before it can be closed.
  Opening and closing costs about $0.08 in spread.

$ mm monfunded order --market BTC --side long --notional 5000 --leverage 2
  p7376f3a26a39: BTC long $5,000.00 at 2x, filled at 60000.5, mark 60000, P&L -$0.04; can close from 2026-10-06T12:31:50.760Z.
  Close it with `mm monfunded close --position p7376f3a26a39` once the 60 s hold is over.

$ mm monfunded close --position p7376f3a26a39
  Refused (HOLD_TIME): Positions stay open at least 60 s after their fill; p7376f3a26a39 can close from 2026-10-06T12:31:50.760Z (in 60 s).

$ mm monfunded order --market BTC --side short --notional 5000 --leverage 2
  Refused (HEDGING): The account is already long BTC (p7376f3a26a39), and MonFunded takes one side of a market at a time.

# Day 1: BTC rises to 63,300 and a minute passes.

$ mm monfunded close --position p7376f3a26a39
  p7376f3a26a39: BTC long $5,000.00 at 2x, closed at 63299.5: P&L +$274.91.
  Account 0x1cce310ae7d91265f4d95d8453c99969a01330b0bec2c7c119b0e16a93a74b4e: balance $10,274.91, equity $10,274.91.

# The next day, BTC back at 60,000.

$ mm monfunded order --market BTC --side long --notional 5000 --leverage 2
  p83f620237b76: BTC long $5,000.00 at 2x, filled at 60000.5, mark 60000, P&L -$0.04; can close from 2026-10-07T12:32:53.760Z.
  Close it with `mm monfunded close --position p83f620237b76` once the 60 s hold is over.

# Day 2: BTC rises to 63,300 and a minute passes.

$ mm monfunded close --position p83f620237b76
  p83f620237b76: BTC long $5,000.00 at 2x, closed at 63299.5: P&L +$274.91.
  Account 0x1cce310ae7d91265f4d95d8453c99969a01330b0bec2c7c119b0e16a93a74b4e: balance $10,549.83, equity $10,549.83.

# The next day, BTC back at 60,000.

$ mm monfunded order --market BTC --side long --notional 5000 --leverage 2
  p942ab26e182d: BTC long $5,000.00 at 2x, filled at 60000.5, mark 60000, P&L -$0.04; can close from 2026-10-08T12:33:56.760Z.
  Close it with `mm monfunded close --position p942ab26e182d` once the 60 s hold is over.

# Day 3: BTC rises to 63,300 and a minute passes.

$ mm monfunded close --position p942ab26e182d
  p942ab26e182d: BTC long $5,000.00 at 2x, closed at 63299.5: P&L +$274.91.
  Account 0x1cce310ae7d91265f4d95d8453c99969a01330b0bec2c7c119b0e16a93a74b4e: balance $10,824.74, equity $10,824.74.

# The next day, BTC back at 60,000.

$ mm monfunded order --market BTC --side long --notional 5000 --leverage 2
  pacc3c102e935: BTC long $5,000.00 at 2x, filled at 60000.5, mark 60000, P&L -$0.04; can close from 2026-10-09T12:34:59.760Z.
  Close it with `mm monfunded close --position pacc3c102e935` once the 60 s hold is over.

# Day 4: BTC rises to 63,300 and a minute passes.

$ mm monfunded close --position pacc3c102e935
  pacc3c102e935: BTC long $5,000.00 at 2x, closed at 63299.5: P&L +$274.91.
  Passed: the assessment reached its target, so account 0x1cce310ae7d91265f4d95d8453c99969a01330b0bec2c7c119b0e16a93a74b4e is now funded (balance reset to $10,000.00). Profit made from here can be withdrawn.

$ mm monfunded order --market BTC --side long --notional 5000 --leverage 2
  pa735c42de9d9: BTC long $5,000.00 at 2x, filled at 60000.5, mark 60000, P&L -$0.04; can close from 2026-10-10T12:36:02.760Z.
  Close it with `mm monfunded close --position pa735c42de9d9` once the 60 s hold is over.

# BTC rises to 66,000 and a minute passes.

$ mm monfunded close --position pa735c42de9d9
  pa735c42de9d9: BTC long $5,000.00 at 2x, closed at 65999.5: P&L +$499.91.
  Account 0x1cce310ae7d91265f4d95d8453c99969a01330b0bec2c7c119b0e16a93a74b4e: balance $10,499.91, equity $10,499.91.

$ mm monfunded status
  Signed in to MonFunded (http://127.0.0.1:4417) as 0x13f73e11397411136dbB74ea8f76A7eb10e47AbB.
  Entries are open: fees go to the MonFunded contract 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f on Monad.
  $10,000 funded account 0x1cce310ae7d91265f4d95d8453c99969a01330b0bec2c7c119b0e16a93a74b4e: equity $10,499.91, balance $10,499.91.
  Consistency: the best day ($499.91) is 100 % of this phase’s profit; the limit is 30 %, so a payout asked now is held for a person’s review.
  Withdrawable now: $499.91 (you receive $399.93).
  Daily loss room: $799.91 (the account fails $300.00 below today’s opening equity; today +$499.91).
  Drawdown room: $1,499.91 above the $9,000.00 floor.

# A payout takes the whole profit at once. This one waits for a person at MonFunded, who releases it before it can pay or be claimed; the operator’s payouts are paused meanwhile (as when its wallet runs out of MON), so this one is claimed.

$ mm monfunded withdraw --token ausd --yes
  0x9e5cc0cee4ca75736b56a6dd44d41294b6c737fea5d7738c6aba96efe79e2242: $499.91 off the balance, 399.93 AUSD to you, held for review: MonFunded checks every payout, and a person decides on this one before it pays.

$ mm monfunded claim --withdrawal 0x9e5cc0cee4ca75736b56a6dd44d41294b6c737fea5d7738c6aba96efe79e2242 --yes
  Claimed 399.93 AUSD in https://monadscan.com/tx/0x0fc9f842bf24fa4624f9b33e483c0be4aea830d3e238737d4927dd9c1b4d10fa.

# Chain: the trader holds 399.93 AUSD; the contract marks 0x9e5cc0ce… paid. The account stays paused until it trades again from its starting balance.

End to end: every step and every on-chain check passed.
```

What to notice:

- `buy` without `--yes` shows the whole payment: the amount and coin, where it comes from and goes
  to, the contract, and both transactions. Nothing is signed.
- `coach` warns about a position that a 0.75 % move would end, and blocks leverage above the cap.
- `close` inside the 60-second hold is refused on the spot, before the server is even asked, and
  so is the other side of a market the account already holds.
- The 10 % target is reached over four days: no single day may be worth more than 30 % of the
  profit, and after the first day `status` says the pass would wait.
- `withdraw` takes the whole profit at once (no `--amount`); the account pauses until a person at
  MonFunded releases or declines it. With the operator paused, the trader then claims it from the
  contract with MonFunded's own signature instead of waiting for the operator's payout.

`npm run test:e2e -- --serve` runs the same steps against the production server
(`server/serve.mjs`). Build the site first with `npm run build` at the repository root.

## 2. With MetaMask Agent Wallet on monfunded.com

You need three things:

- MetaMask Agent Wallet 6.2 or later, signed in ([README.md](README.md) has the steps).
- The plugin, installed.
- USDC and a little MON on Monad in your Agent Wallet.

Then run:

```sh
mm monfunded status                                          # the plans, and whether entries are open
mm monfunded login                                           # MetaMask signs MonFunded's sign-in message
mm monfunded buy --size 10k --pay usdc                       # the payment; nothing is signed
mm monfunded buy --size 10k --pay usdc --yes                 # MetaMask sends approve and enter
mm monfunded status                                          # the new account and its rule meters
mm monfunded coach --market BTC --side long --notional 1000 --leverage 2
mm monfunded order --market BTC --side long --notional 1000 --leverage 2
mm monfunded close --position <the id order printed>         # at least 60 s after the fill
mm monfunded withdraw --token usdc --yes                     # once funded and in profit: takes it all
mm monfunded claim --withdrawal <id> --yes                   # only if a payout hasn't arrived
```

`login` asks MetaMask to sign one message, a Sign-In with Ethereum (EIP-4361) message the plugin
checks field by field first (monfunded.com, your wallet, Monad, a fresh nonce, five minutes of
validity, nothing else):

```text
monfunded.com wants you to sign in with your Ethereum account:
<your wallet>

Sign in to the MonFunded Challenge.

URI: https://monfunded.com
Version: 1
Chain ID: 143
Nonce: <32 hex characters>
Issued At: <now>
Expiration Time: <now + 5 minutes>
```

Three things to know:

- **The plugin pays MonFunded's contract only.** The address is written into the plugin, not taken
  from the server, and so is Kuru's MON_USDC book for fees in MON. A server that names another
  contract is refused, and nothing is signed.
- **Guard Mode may ask for your approval.** It can ask before MetaMask sends the fee or the
  claim, by a push notification or an email. The command waits, and prints `[AWAITING_MFA]` for
  agents to spot.
- **Entries are open.** MonFunded's contract is live on Monad
  (`0x6B8e2bA530D44298Dea8512eDF17D01181459f36`, since 2026-10-05); `status` says so on its
  second line.

## 3. Ask an agent

Put [SKILL.md](SKILL.md) in your agent's skills (see [README.md](README.md), "Use it"). Then ask
it, for example in Claude Code:

> Using MonFunded, buy the smallest assessment with USDC. Show me the payment before you pay.

> Check my MonFunded account. If there is room, open a 2x long on BTC with $500, but run the coach
> first and tell me how far the price can fall before the account fails.

> Take $50 of profit off my funded MonFunded account, paid in AUSD. Show me the payout first.

The agent runs the commands with `--json` and shows you each plan. It adds `--yes` only after you
say yes. It never goes past your budget, and it stops for your MetaMask approval when Guard Mode
asks for one.
