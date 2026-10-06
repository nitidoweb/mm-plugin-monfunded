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
| `mm monfunded buy --size 10k --pay usdc` | Pays for an assessment in USDC, AUSD or MON | The fee (after showing it) |
| `mm monfunded status` | Accounts, balance, equity, rule meters, open positions, withdrawable profit | Nothing |
| `mm monfunded coach --market BTC --side long --notional 1000 --leverage 2` | Checks an order against the rules without sending it | Nothing |
| `mm monfunded order --market BTC --side long --notional 1000 --leverage 2` | Opens a long or short position | Nothing (the account is simulated) |
| `mm monfunded close --position p1a2b3c4d5e6f` | Closes a position once its 60-second hold is over | Nothing |
| `mm monfunded withdraw --token usdc` | Takes all the profit off a funded account at once; you receive 80 % | Nothing (MonFunded pays you) |
| `mm monfunded claim --withdrawal 0x…` | Collects an unpaid payout from the contract yourself | The claim (after showing it) |

Add `--json` for output an agent can read, and `--help` to any command for its flags.

## What you need

- Node.js 24 or later. MetaMask's CLI itself asks for 22.18; this plugin's own build asks for 24
  (`engines` in `package.json`), so 24 is the version that gets you through both.
- MetaMask Agent Wallet 6.2 or later, signed in and set up, as in MetaMask's
  [quickstart](https://docs.metamask.io/agent-wallet/quickstart/):

  ```sh
  npm install -g @metamask/agent-wallet
  mm login
  mm init
  ```

- To buy: USDC, AUSD or MON on Monad in the Agent Wallet, and a little MON for gas.

## Install

The plugin is not on npm yet. It installs from this folder instead — four steps, meant to be
pasted one after the other, and nothing here needs an account beyond the Agent Wallet one above.

1. Get the code:

   ```sh
   git clone https://github.com/nitidoweb/monfunded.git
   cd monfunded/agent
   ```

2. Plugins are a beta feature of `mm`. Turn them on once (the second line allows installing from a
   folder rather than from npm):

   ```sh
   mm config set experimentalPlugins true
   mm config set experimentalAllowUnverifiedInstalls true
   ```

3. Build the plugin and install it from this folder:

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

4. Check that it works:

   ```sh
   mm plugins          # mm-plugin-monfunded 0.2.0
   mm monfunded status
   ```

   `status` reads the active wallet, so `mm login` has to have happened; without it every command
   answers `AUTH_FAILED`. Before you sign in to MonFunded it shows the plans and whether entries
   are open.

To remove it: `mm plugins uninstall mm-plugin-monfunded`, and `rm -rf ~/.monfunded` to forget the
MonFunded session.

## Use it

```sh
mm monfunded login
mm monfunded buy --size 10k --pay usdc          # shows the payment, signs nothing
mm monfunded buy --size 10k --pay usdc --yes    # pays it
mm monfunded coach --market BTC --side long --notional 1000 --leverage 2
mm monfunded order --market BTC --side long --notional 1000 --leverage 2
mm monfunded status
mm monfunded close --position p1a2b3c4d5e6f
mm monfunded withdraw --token usdc --yes
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
- **Checked before paying.** `buy` pays only when you are signed in with the paying wallet, the
  wallet is under MonFunded's limits (five assessments running at once, $400,000 of funded
  accounts), the contract charges exactly the listed fee and takes MonFunded's USDC and AUSD, and
  the wallet holds enough. It approves exactly the fee, never more.
  The limits are read again right before each signature. If registering the account fails after
  paying, the error says the fee is paid (`PAID_NOT_REGISTERED`, never a code that elsewhere means
  nothing was paid) and gives the command that registers it without paying again (`--entry-tx`).
- **Only MonFunded's sign-in is signed.** `login` signs a Sign-In with Ethereum (EIP-4361) message
  and checks every field first: the domain and URI are the API's own (`monfunded.com`,
  `https://monfunded.com`), the address is the active wallet, the chain is Monad (143), the nonce
  is the one the server just gave (it goes back with the signature and works once), the message
  was issued within 5 minutes of your clock and expires within 10, and there is nothing else in it
  (no resources, no request id, no extra text). Anything else is refused unsigned. It looks like
  this:

  ```text
  monfunded.com wants you to sign in with your Ethereum account:
  0xC9AD2AE47243FF0f2bCC634B63d2E1159c284231

  Sign in to the MonFunded Challenge.

  URI: https://monfunded.com
  Version: 1
  Chain ID: 143
  Nonce: 3f1c0a9e5b7d4c2e8a6f1b0d9c7e5a3b
  Issued At: 2026-09-15T12:00:00.000Z
  Expiration Time: 2026-09-15T12:05:00.000Z
  ```
- **Pinned to MonFunded.** The plugin talks to `https://monfunded.com` and pays only the contract
  written into the plugin (`MONFUNDED_CONTRACT` in `src/lib/constants.ts`:
  `0x6B8e2bA530D44298Dea8512eDF17D01181459f36`), whatever the API says.
  A fee in MON is swapped only on Kuru's MON_USDC book (`0x065c9d28e428a0db40191a54d33d5b7c71a9c394`),
  and everything runs on Monad (143). An API that names another contract is refused
  (`BAD_CONFIG`) and nothing is signed. Another server needs the developer flag (Settings), which trusts that server
  as it is and says so loudly on every command.
- **Payouts go to your wallet only.** The contract pays the wallet that owns the account, with
  MonFunded's signature over that wallet, the coin and the amount.
- **The session stays private.** The MonFunded session cookie is kept in
  `~/.monfunded/agent-session.json`, readable by you alone, and is never printed. It lasts 7 days.

## Settings

| Variable | What it does |
|---|---|
| `MONFUNDED_API_URL` | Talk to another MonFunded server, e.g. `http://localhost:4417` for local testing: only https, or http on this machine, and only with `MONFUNDED_DEV=1`. |
| `MONFUNDED_DEV` | `1` turns on developer mode: `MONFUNDED_API_URL` is honored, and that server's contract and MON book are trusted as it names them. Every command then prints a warning on stderr. For test servers and test funds only; never set it for real money. |
| `MONFUNDED_AGENT_HOME` | Where the session file lives (default `~/.monfunded`). |

## Troubleshooting

- **`AUTH_FAILED … run mm login`**: MetaMask Agent Wallet itself isn't signed in: `mm login`.
- **`NOT_SIGNED_IN`** or **`WRONG_WALLET`**: `mm monfunded login` (again after switching wallets).
- **`ENTRIES_CLOSED`**: the plan is paused, or MonFunded is taking no entries right now; nothing
  was paid.
- **`BAD_CONFIG`**: MonFunded's API named a contract or a coin other than the ones this version
  pins. Nothing was paid; check for a newer version of the plugin.
- **`PAID_NOT_REGISTERED`**: the fee is paid but the account isn't started (the message says why).
  Don't pay again: run the `--entry-tx` command from the hint within 72 hours.
- **`UNEXPECTED_MESSAGE`**: the server's sign-in message failed a check (the message says which).
  Check the computer's clock (it must be within 5 minutes), then `mm monfunded login` again.
- **`INVALID_API_URL`**: `MONFUNDED_API_URL` is set without `MONFUNDED_DEV=1`, or isn't an origin.
  Unset it to use monfunded.com.
- **`[AWAITING_MFA]`**: Guard Mode wants your approval: approve it in MetaMask (phone or email), and
  see `mm wallet requests list`.
- **`PLUGIN_BETA_DISABLED`**: turn plugins on (Install, step 1).

## For developers

```sh
npm test            # 83 unit tests: flows, sign-in checks, API client and pins, session file, signer, with a mocked MetaMask executor
npm run test:e2e    # the whole flow against a local MonFunded server and the real contract (see below)
npm run typecheck
npm run build
```

`npm run test:e2e` needs `npm install` at the repository root too: it starts MonFunded's own server
(`server/challenge.mjs`) on port 4417, runs the compiled contract (`contracts/out`) in an in-memory
EVM, and drives the plugin's flows with a stand-in for MetaMask's executor, checking the chain after
every payment. It reaches the server the way a developer would, in developer mode
(`MONFUNDED_DEV=1` with `MONFUNDED_API_URL`), so the local contract is trusted. `npm run test:e2e --
--serve` uses the production `server/serve.mjs` instead (after `npm run build` at the root). The
repository's `npm run lint` covers this folder. `npm test` and `npm run test:e2e` both run in the
deploy gate (`ops/deploy.sh`), so a server change that breaks the plugin stops the deploy.

If MonFunded ever deploys a new contract: set `MONFUNDED_CONTRACT` in `src/lib/constants.ts` to the
address `scripts/deploy-contract.mjs` printed, raise the version in `package.json` and
`src/lib/constants.ts`, rebuild and publish.

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

## Why `@metamask/agent-wallet` is held at 6.2.1

The rest of MonFunded runs its dependencies current. This one is pinned to the 6.x line on purpose:
`package.json`'s `mm.minCliVersion` declares `^6.2.0`, so the plugin is built and typed against the
same CLI major it claims to support. 7.0.0 typechecks and passes all 68 tests here, but nothing on
this box can exercise a real `mm` 7 CLI, and building against a major the manifest does not claim
would make the declaration untrue rather than merely conservative.

Moving to 7 means changing both together — the dependency and `minCliVersion` — and testing against
the real CLI. Until then, this pin is the honest pair.
