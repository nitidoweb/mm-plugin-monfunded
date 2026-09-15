// What the plugin knows that the MonFunded API doesn't send: where things live, and a few of the
// server's rules (server/challenge-rules.mjs) so a refusal can be explained before the request is
// sent. The server stays the judge of every rule; these only make the plugin's answers clearer.

export const VERSION = '0.1.0'
export const USER_AGENT = `mm-plugin-monfunded/${VERSION} (+https://monfunded.com/agents/)`

// Monad mainnet: the contract, the coins and every transaction the plugin sends.
export const CHAIN_ID = 143
export const EXPLORER_TX = 'https://monadscan.com/tx/'

// The MonFunded API, and the environment variable that points the plugin at another server (a
// local test server: https, or http on localhost only).
export const DEFAULT_API = 'https://monfunded.com'
export const API_URL_ENV = 'MONFUNDED_API_URL'
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
// Every challenge market is a crypto perp on Perpl: the plan's `leverage.crypto` caps them all.
export const MARKET_CATEGORY = 'crypto'
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
