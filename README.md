# MonFunded plugin for MetaMask Agent Wallet

This plugin lets an AI agent, or you, run a MonFunded prop-trading challenge from the command line of
MetaMask Agent Wallet (`mm`), on Monad: buy an assessment, trade it, take profit off a funded
account and claim payouts.

- MonFunded: https://monfunded.com (the agents page: https://monfunded.com/agents/)
- MetaMask Agent Wallet: https://docs.metamask.io/agent-wallet/
- For the agent itself: [SKILL.md](SKILL.md). A walk-through of the whole flow: [demo.md](demo.md).

## Commands

| Command | What it does | What MetaMask signs |
|---|---|---|
| `mm monfunded login` | Signs in to MonFunded with the active wallet | A sign-in message (no gas) |
| `mm monfunded buy --size 5k --risk tight --pay usdc` | Pays for an assessment in USDC, AUSD or MON | The fee (after showing it) |
| `mm monfunded status` | Accounts, balance, equity, rule meters, open positions, withdrawable profit | Nothing |
| `mm monfunded coach --market BTC --side long --notional 1000 --leverage 2` | Checks an order against the rules without sending it | Nothing |
| `mm monfunded order --market BTC --side long --notional 1000 --leverage 2` | Opens a long or short position | Nothing (the account is simulated) |
| `mm monfunded close --position p1a2b3c4d5e6f` | Closes a position once its 60-second hold is over | Nothing |
| `mm monfunded withdraw --amount 100 --token usdc` | Takes profit off a funded account; you receive 80 % | Nothing (MonFunded pays you) |
| `mm monfunded claim --withdrawal 0x…` | Collects an unpaid payout from the contract yourself | The claim (after showing it) |

Add `--json` for output an agent can read, and `--help` to any command for its flags.

## What you need

- Node.js 22.18 or later.
- MetaMask Agent Wallet 6.2 or later, signed in and set up, as in MetaMask's
  [quickstart](https://docs.metamask.io/agent-wallet/quickstart/):

  ```sh
  npm install -g @metamask/agent-wallet
  mm login
  mm init
  ```

- To buy: USDC, AUSD or MON on Monad in the Agent Wallet, and a little MON for gas.

## Install

1. Plugins are a beta feature of `mm`. Turn them on once (the second line allows installing from a
   folder rather than from npm):

   ```sh
   mm config set experimentalPlugins true
   mm config set experimentalAllowUnverifiedInstalls true
   ```

2. In this folder (`agent/` in the MonFunded repository), build the plugin and install it:

   ```sh
   npm install && npm run build
   mm plugins install "file:$PWD" --accept-permissions
   ```

   `--accept-permissions` accepts the consent screen, which lists what each command may do. Leave
   it out to read the screen first:

   | Commands | Capabilities | Why |
   |---|---|---|
   | `login`, `buy`, `claim` | `wallet-read`, `wallet-submit` | The active address; MetaMask signs the sign-in message, the fee, the claim |
   | `status`, `coach`, `order`, `close`, `withdraw` | `wallet-read` | The active address, to use its MonFunded session |

   Every command works on Monad (chain 143) only.

3. Check that it works:

   ```sh
   mm monfunded status
   ```

   Before you sign in, it shows the plans and whether entries are open.

To remove it: `mm plugins uninstall mm-plugin-monfunded`, and `rm -rf ~/.monfunded` to forget the
MonFunded session.

## Use it

```sh
mm monfunded login
mm monfunded buy --size 5k --risk tight --pay usdc          # shows the payment, signs nothing
mm monfunded buy --size 5k --risk tight --pay usdc --yes    # pays it
mm monfunded coach --market BTC --side long --notional 1000 --leverage 2
mm monfunded order --market BTC --side long --notional 1000 --leverage 2
mm monfunded status
mm monfunded close --position p1a2b3c4d5e6f
mm monfunded withdraw --amount 100 --token usdc --yes
mm monfunded claim --withdrawal 0x… --yes
```

In a terminal, `buy`, `withdraw` and `claim` show the plan and ask before going ahead; `--yes`
skips the question. Run by an agent (no terminal, or `--json`), they only return the plan unless
`--yes` is given, so the agent can show it to you first. [SKILL.md](SKILL.md) tells agents to do
exactly that.

To let an agent use it, give it [SKILL.md](SKILL.md). For Claude Code:

```sh
mkdir -p ~/.claude/skills/monfunded && cp SKILL.md ~/.claude/skills/monfunded/
```

## How it keeps you safe

- **Nothing moves without a plan.** Each payment shows the amount and coin, where it comes from,
  where it goes, the contract and every transaction before anything is signed.
- **MetaMask's checks apply.** Everything the plugin asks MetaMask to sign goes through Agent
  Wallet's policy: Blockaid screening, Guard Mode (allowlists and 2FA approvals) and the 24-hour
  outflow limit. The plugin never sees a private key or a recovery phrase; `mm` doesn't give plugins
  either.
- **Checked before paying.** `buy` pays only when you are signed in with the paying wallet, no
  assessment is running (one at a time), the contract charges exactly the listed fee and takes
  MonFunded's USDC and AUSD, and the wallet holds enough. It approves exactly the fee, never more.
  If registering the account fails after paying, the error gives the command that registers it
  without paying again (`--entry-tx`).
- **Only MonFunded's sign-in message is signed.** `login` refuses any other text from the server.
- **Payouts go to your wallet only.** The contract pays the wallet that owns the account, with
  MonFunded's signature over that wallet, the coin and the amount.
- **The session stays private.** The MonFunded session cookie is kept in
  `~/.monfunded/agent-session.json`, readable by you alone, and is never printed. It lasts 7 days.

## Settings

| Variable | What it does |
|---|---|
| `MONFUNDED_API_URL` | Talk to another MonFunded server, e.g. `http://localhost:4417` for local testing. Only https, or http on this machine. |
| `MONFUNDED_AGENT_HOME` | Where the session file lives (default `~/.monfunded`). |

## Troubleshooting

- **`AUTH_FAILED … run mm login`**: MetaMask Agent Wallet itself isn't signed in: `mm login`.
- **`NOT_SIGNED_IN`** or **`WRONG_WALLET`**: `mm monfunded login` (again after switching wallets).
- **`ENTRIES_CLOSED`**: MonFunded's contract isn't deployed on Monad yet; nothing was paid.
- **`[AWAITING_MFA]`**: Guard Mode wants your approval: approve it in MetaMask (phone or email), and
  see `mm wallet requests list`.
- **`PLUGIN_BETA_DISABLED`**: turn plugins on (Install, step 1).

## For developers

```sh
npm test            # 57 unit tests: flows, API client, session file, signer, with a mocked MetaMask executor
npm run test:e2e    # the whole flow against a local MonFunded server and the real contract (see below)
npm run typecheck
npm run build
```

`npm run test:e2e` needs `npm install` at the repository root too: it starts MonFunded's own server
(`server/challenge.mjs`) on port 4417, runs the compiled contract (`contracts/out`) in an in-memory
EVM, and drives the plugin's flows with a stand-in for MetaMask's executor, checking the chain after
every payment. `npm run test:e2e -- --serve` uses the production `server/serve.mjs` instead (after
`npm run build` at the root). The repository's `npm run lint` covers this folder.

Layout:

- `src/commands/monfunded/`: one file per command (the `mm` command classes).
- `src/host.ts`: between `mm` and the flows: the active wallet, `mm`'s RPC client for Monad,
  MetaMask's signer, the confirmation prompt, errors as `mm` shows them.
- `src/sdk.ts`: `mm`'s plugin SDK, taken from the `mm` that is running. A plugin installed from a
  folder is a symlink, so Node would otherwise load the folder's development copy of the CLI, and
  a second CLI in one process crashes (`window.addEventListener is not a function`). For the same
  reason the package has no peer dependency on `@metamask/agent-wallet`: npm would install a copy.
- `src/lib/`: the flows and everything they use, with no `mm` in them (so the tests run without it).
- `package.json#mm`: the manifest `mm` reads for the consent screen and the capability checks.
