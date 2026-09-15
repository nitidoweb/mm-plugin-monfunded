// What the plugin knows that the MonFunded API doesn't send: where things live, what it trusts
// with money (pinned here, never taken from the API), and a few of the server's rules
// (server/challenge-rules.mjs) so a refusal can be explained before the request is sent. The
// server stays the judge of every rule; these only make the plugin's answers clearer.
import type { Address } from './types.ts'

export const VERSION = '0.1.0'
export const USER_AGENT = `mm-plugin-monfunded/${VERSION} (+https://monfunded.com/agents/)`

// Monad mainnet: the contract, the coins and every transaction the plugin sends.
export const CHAIN_ID = 143
export const EXPLORER_TX = 'https://monadscan.com/tx/'

// The MonFunded API. MONFUNDED_API_URL points the plugin at another server (a local test server:
// https, or http on this machine only), and only together with MONFUNDED_DEV=1: a developer's
// server is trusted as it is (its contract included), so the flag says so loudly on every command.
export const DEFAULT_API = 'https://monfunded.com'
export const API_URL_ENV = 'MONFUNDED_API_URL'
export const DEV_ENV = 'MONFUNDED_DEV'

// MonFunded's contract on Monad (contracts/MonFundedChallenge.sol), pinned: the plugin pays fees
// to and claims payouts from this address only, whatever the API names. It is null until the
// contract is deployed; set it then (the address scripts/deploy-contract.mjs prints) and publish
// the plugin again. While it is null the plugin pays no contract at all, and an API that names
// one is refused with PLUGIN_OUTDATED.
export const MONFUNDED_CONTRACT: Address | null = null
// Kuru's MON_USDC book on Monad, where the contract sells a fee paid in MON (enterWithMon), pinned
// the same way (src/config.ts in the MonFunded repository lists it too).
export const MON_MARKET: Address = '0x065c9d28e428a0db40191a54d33d5b7c71a9c394'

// MonFunded's sign-in: an EIP-4361 (Sign-In with Ethereum) message for this API's domain, the
// wallet, Monad and a nonce, with this statement. The plugin signs nothing else.
export const SIGN_IN_STATEMENT = 'Sign in to the MonFunded Challenge.'
// The sign-in message's issue time may differ from this computer's clock by this much, and it
// may be valid for at most this long.
export const SIGN_IN_SKEW_MS = 5 * 60_000
export const SIGN_IN_MAX_TTL_MS = 10 * 60_000
// Where the plugin keeps its MonFunded session (default ~/.monfunded).
export const HOME_ENV = 'MONFUNDED_AGENT_HOME'
// Kuru's market-data API, for the MON price of a fee paid in MON.
export const KURU_API = 'https://exchange.kuru.io'

// The contract's two coins on Monad (both 6 decimals, both a dollar). The API names them too;
// the plugin refuses an API or a contract that names others.
export const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
export const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'

// The server's order rules: the smallest position, the minimum hold before a close, and the
// share of a position's margin whose loss liquidates it.
export const MIN_NOTIONAL_USD = 10
export const MIN_HOLD_MS = 60_000
export const LIQUIDATION_LOSS = 0.9
// A challenge market's category, which keys the plan's leverage cap: MonFunded liquidity's forex
// pairs ('fx:EURUSD') are forex, Perpl's perps ('perpl:BTC') crypto.
export const categoryOf = (market: string) => (market.startsWith('fx:') ? 'forex' : 'crypto')
// Where a market's quotes and fills come from, as the coach names it.
export const sourceOf = (market: string) => (market.startsWith('fx:') ? 'MonFunded liquidity' : 'Perpl')
// The coach warns when an adverse move smaller than this (in %) fails the account.
export const CAUTION_MOVE_PCT = 1

// A fee paid in MON is sold for USDC on Kuru's MON_USDC book inside the contract. The quote
// walks the book's bids like src/lib/challengeQuote.ts, adds a 0.5 % buffer and rounds up to the
// book's 1e8 wei size grid; the wallet keeps Monad's 10 MON account reserve on top.
export const MON_BOOK = 'MON_USDC'
export const MON_QUOTE_BUFFER_BPS = 50
export const MON_SIZE_GRID = 10n ** 8n
export const MON_RESERVE_WEI = 10n * 10n ** 18n

// How long the plugin waits for things the server does after answering: a fill or a close (the
// next Perpl quote, well under a second), an operator payout, and a new entry's receipt reaching
// the server's RPC.
export const POLL_MS = 1_000
export const FILL_WAIT_MS = 15_000
export const PAYOUT_WAIT_MS = 20_000
export const ENTRY_ATTEMPTS = 6
export const REQUEST_TIMEOUT_MS = 20_000
// The longest the plugin waits for a transaction's receipt after MetaMask sent it.
export const RECEIPT_TIMEOUT_MS = 120_000
