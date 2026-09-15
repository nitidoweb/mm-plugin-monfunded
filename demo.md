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

It prints each step as the terminal session it stands for, and it checks the chain after every
payment. Here is one run (ids, addresses and times change every time):

```text
MonFunded agent plugin, end to end: in-memory Monad (contract 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f), MonFunded server on http://127.0.0.1:4417, MetaMask stand-in for 0xC9AD2AE47243FF0f2bCC634B63d2E1159c284231.

$ mm monfunded status
  Not signed in to MonFunded (http://127.0.0.1:4417).
  Run `mm monfunded login` to sign in with the active wallet.
  Entries are open: fees go to the MonFunded contract 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f on Monad.
  14 plans on sale, from $30.00.

$ mm monfunded login
  Signed in to MonFunded (http://127.0.0.1:4417) as 0xC9AD2AE47243FF0f2bCC634B63d2E1159c284231 until 2026-09-22T00:37:22.620Z.
  The session is kept in /tmp/monfunded-agent-e2e-qAoJ5k/agent/agent-session.json, readable by this user only.
  No account yet: see the plans with `mm monfunded status`, then `mm monfunded buy`.

$ mm monfunded buy --size 5k --risk tight --pay usdc
  Buy the Tight $5,000 assessment (plan tight-5000)
    Amount:   30.00 USDC
    From:     0xC9AD2AE47243FF0f2bCC634B63d2E1159c284231
    To:       the MonFunded contract 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f
    Contract: 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f
    Chain:    Monad (chain 143)
    Step 1:   approve(0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f, 30000000) on USDC (0x754704Bc059F8C67012fEd69BC8A327a5aafb603): lets the contract take exactly the fee, nothing more.
    Step 2:   enter(0) on 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f: moves 30.00 USDC into the contract’s USDC reserve and starts the account.
    Note:     Rules: close positions at 9 % profit to pass; losing 3 % in a day or 3 % in total fails the account.
    Note:     The fee is not refundable once the account is active.
  Nothing was signed or paid. Run the same command again with --yes to sign and pay.

$ mm monfunded buy --size 5k --risk tight --pay usdc --yes
  Paid in https://monadscan.com/tx/0xcb836d6b0161385b8021e5ff44b1b05220a03fa32b7dcf421b75831b4e881905.
  Tight $5,000 assessment 0xb1792afd217a01d7b3349e2356473e9b8cbd2470ca7b7638de9cb079329aeca1: equity $5,000.00, balance $5,000.00.
  Profit target: $0.00 of $450.00 (0 %); it counts once no position is open.
  Daily loss room: $150.00 (the account fails $150.00 below today’s opening equity; today $0.00).
  Drawdown room: $150.00 above the $4,850.00 floor.

# Chain: the trader holds 970 USDC; the contract’s USDC reserve holds 530.

$ mm monfunded buy --size 5k --risk tight --pay usdc --yes
  Refused (ALREADY_ACTIVE): This wallet already has an assessment running (0xb1792afd217a01d7b3349e2356473e9b8cbd2470ca7b7638de9cb079329aeca1), and MonFunded allows one at a time. Nothing was paid.

$ mm monfunded coach --market BTC --side long --notional 20000 --leverage 5
  A 0.75 % move against you (BTC down to about 59551) fails the account on its daily loss limit.
  The account fails before this position’s liquidation point (18 % away).
  It fills at the next Perpl quote, near 60000.5 (the ask), and must stay open 60 s before it can be closed.
  Opening and closing costs about $0.33 in spread.
  Caution: under 1 % is an ordinary move for crypto. A smaller --notional leaves more room.

$ mm monfunded coach --market BTC --side long --notional 5000 --leverage 6
  MonFunded would refuse this order: 6x is above the 5x cap on BTC (the plan allows 5x, Perpl 15x). Pass --leverage 5 or less.
  A 3 % move against you (BTC down to about 58201) fails the account on its daily loss limit.
  The account fails before this position’s liquidation point (15 % away).
  It fills at the next Perpl quote, near 60000.5 (the ask), and must stay open 60 s before it can be closed.
  Opening and closing costs about $0.08 in spread.

$ mm monfunded coach --market BTC --side long --notional 5000 --leverage 2
  A 3 % move against you (BTC down to about 58201) fails the account on its daily loss limit.
  The account fails before this position’s liquidation point (45 % away).
  It fills at the next Perpl quote, near 60000.5 (the ask), and must stay open 60 s before it can be closed.
  Opening and closing costs about $0.08 in spread.

$ mm monfunded order --market BTC --side long --notional 5000 --leverage 2
  p49a1a9ce7389: BTC long $5,000.00 at 2x, filled at 60000.5, mark 60000, P&L -$0.04; can close from 2026-09-15T00:38:23.593Z.
  Close it with `mm monfunded close --position p49a1a9ce7389` once the 60 s hold is over.

$ mm monfunded close --position p49a1a9ce7389
  Refused (HOLD_TIME): Positions stay open at least 60 s after their fill; p49a1a9ce7389 can close from 2026-09-15T00:38:23.593Z (in 60 s).

# BTC rises to 65,500 and a minute passes.

$ mm monfunded close --position p49a1a9ce7389
  p49a1a9ce7389: BTC long $5,000.00 at 2x, closed at 65499.5: P&L +$458.25.
  Passed: the assessment reached its target, so account 0xb1792afd217a01d7b3349e2356473e9b8cbd2470ca7b7638de9cb079329aeca1 is now funded (balance reset to $5,000.00). Profit made from here can be withdrawn.

$ mm monfunded order --market BTC --side long --notional 5000 --leverage 2
  p1870fb286255: BTC long $5,000.00 at 2x, filled at 65500.5, mark 65500, P&L -$0.04; can close from 2026-09-15T00:39:26.593Z.
  Close it with `mm monfunded close --position p1870fb286255` once the 60 s hold is over.

# BTC rises to 71,500 and a minute passes.

$ mm monfunded close --position p1870fb286255
  p1870fb286255: BTC long $5,000.00 at 2x, closed at 71499.5: P&L +$457.94.
  Account 0xb1792afd217a01d7b3349e2356473e9b8cbd2470ca7b7638de9cb079329aeca1: balance $5,457.94, equity $5,457.94.

$ mm monfunded status
  Signed in to MonFunded (http://127.0.0.1:4417) as 0xC9AD2AE47243FF0f2bCC634B63d2E1159c284231.
  Entries are open: fees go to the MonFunded contract 0x5B3D6d231dCBaEafB4762102a1d8a962688ba58f on Monad.
  Tight $5,000 funded account 0xb1792afd217a01d7b3349e2356473e9b8cbd2470ca7b7638de9cb079329aeca1: equity $5,457.94, balance $5,457.94.
  Withdrawable now: $457.94 (you receive $366.34).
  Daily loss room: $607.94 (the account fails $150.00 below today’s opening equity; today +$457.94).
  Drawdown room: $607.94 above the $4,850.00 floor.

# The operator’s payouts are paused (as when its wallet runs out of MON), so this one is claimed.

$ mm monfunded withdraw --amount 100 --token ausd --yes
  0xbcd6568bc86770212ec038c4d4f6a10971210d9dd0d5b524c75d5603733a4dbb: $100.00 off the balance, 80.00 AUSD to you, not paid yet: MonFunded’s operator pays it automatically, or collect it yourself with `mm monfunded claim --withdrawal 0xbcd6568bc86770212ec038c4d4f6a10971210d9dd0d5b524c75d5603733a4dbb`.

$ mm monfunded claim --withdrawal 0xbcd6568bc86770212ec038c4d4f6a10971210d9dd0d5b524c75d5603733a4dbb --yes
  Claimed 80.00 AUSD in https://monadscan.com/tx/0x0fc9f842bf24fa4624f9b33e483c0be4aea830d3e238737d4927dd9c1b4d10fa.

# Chain: the trader holds 80 AUSD; the contract marks 0xbcd6568b… paid.

# The operator’s payouts are back on: this one pays by itself.

$ mm monfunded withdraw --amount 100 --token usdc --yes
  0x4207f4683aaa8154ca440eb5071ac6c576a62beebac4ec1213c286ffb2e9cbd0: $100.00 off the balance, 80.00 USDC to you, paid in https://monadscan.com/tx/0x97b33a346c2e0c3607ab4a3707db1007309aefbe8c9bf77a88347e9b8b211299.

# Chain: the trader holds 1050 USDC and 80 AUSD.

End to end: every step and every on-chain check passed.
```

What to notice:

- `buy` without `--yes` shows the whole payment: the amount and coin, where it comes from and goes
  to, the contract, and both transactions. Nothing is signed.
- The second `buy` is refused before anything is paid, because a wallet runs one assessment at a
  time.
- `coach` warns about a position that a 0.75 % move would end, and blocks leverage above the cap.
- `close` inside the 60-second hold is refused on the spot, before the server is even asked.
- The run covers both ways a payout reaches the trader. First, the trader claims one from the
  contract with MonFunded's signature. Then MonFunded's operator pays the other one.

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
mm monfunded buy --size 5k --risk tight --pay usdc           # the payment; nothing is signed
mm monfunded buy --size 5k --risk tight --pay usdc --yes     # MetaMask sends approve and enter
mm monfunded status                                          # the new account and its rule meters
mm monfunded coach --market BTC --side long --notional 1000 --leverage 2
mm monfunded order --market BTC --side long --notional 1000 --leverage 2
mm monfunded close --position <the id order printed>         # at least 60 s after the fill
mm monfunded withdraw --amount 20 --token usdc --yes         # once funded and in profit
mm monfunded claim --withdrawal <id> --yes                   # only if a payout hasn't arrived
```

Two things to know:

- **Guard Mode may ask for your approval.** It can ask before MetaMask sends the fee or the
  claim, by a push notification or an email. The command waits, and prints `[AWAITING_MFA]` for
  agents to spot.
- **Entries aren't open yet.** Until MonFunded's contract is deployed on Monad, `status` says so,
  and `buy` stops with `ENTRIES_CLOSED` before anything is signed. That is monfunded.com's state as
  of 2026-09-15.

## 3. Ask an agent

Put [SKILL.md](SKILL.md) in your agent's skills (see [README.md](README.md), "Use it"). Then ask
it, for example in Claude Code:

> Using MonFunded, buy the smallest tight assessment with USDC. Show me the payment before you pay.

> Check my MonFunded account. If there is room, open a 2x long on BTC with $500, but run the coach
> first and tell me how far the price can fall before the account fails.

> Take $50 of profit off my funded MonFunded account, paid in AUSD. Show me the payout first.

The agent runs the commands with `--json` and shows you each plan. It adds `--yes` only after you
say yes. It never goes past your budget, and it stops for your MetaMask approval when Guard Mode
asks for one.
