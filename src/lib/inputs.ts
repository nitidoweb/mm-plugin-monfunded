// Every flag the commands take, parsed strictly: the exact shapes below or a plain-words refusal
// (INVALID_INPUT). Nothing is guessed or rounded on the user's behalf.
import { API_URL_ENV, DEFAULT_API, DEV_ENV } from './constants.ts'
import { PluginError } from './errors.ts'
import type { PayoutToken, PayWith, Side } from './types.ts'

const invalid = (flag: string, message: string, hint: string) => new PluginError('INVALID_INPUT', `--${flag}: ${message}`, hint)

// For mm's input schemas: true when `parse` accepts the value, else the refusal's message.
export function valid(parse: () => unknown): true | string {
  try {
    parse()
    return true
  } catch (e) {
    return e instanceof PluginError ? `${e.message} ${e.hint}` : String(e)
  }
}

// An account size in dollars: 10k, 25k, 50k, 100k, 200k, or the whole number (10000).
export function parseSize(raw: string): number {
  const m = /^(\d{1,7})(k?)$/i.exec(raw.trim())
  const size = m ? Number(m[1]) * (m[2] ? 1000 : 1) : NaN
  if (!(size >= 1000 && size <= 1_000_000)) throw invalid('size', `"${raw}" is not an account size.`, 'Use 10k, 25k, 50k, 100k or 200k.')
  return size
}

export function parsePay(raw: string): PayWith {
  const coin = raw.trim().toUpperCase()
  if (coin !== 'USDC' && coin !== 'AUSD' && coin !== 'MON') throw invalid('pay', `"${raw}" is not a coin MonFunded takes.`, 'Use usdc, ausd or mon.')
  return coin
}

export function parsePayoutToken(raw: string): PayoutToken {
  const coin = raw.trim().toUpperCase()
  if (coin !== 'USDC' && coin !== 'AUSD') throw invalid('token', `"${raw}" is not a payout coin.`, 'Use usdc or ausd.')
  return coin
}

// A challenge market: a Perpl perp by its symbol (BTC) or id (perpl:BTC), or an instrument of
// MonFunded liquidity by its code or id: a six-letter pair or commodity (EURGBP, EUR/GBP, XAUUSD) or
// an index ending in its number (GER30, SPX500), with or without fx:. Perpl's symbols are shorter and
// end in a letter. Whether it trades is the server's list (/challenge/prices).
export function parseMarket(raw: string): string {
  const text = raw.trim()
  const pair = /^(?:fx:)?([a-z]{3})\/?([a-z]{3})$/i.exec(text)
  if (pair) return `fx:${(pair[1] + pair[2]).toUpperCase()}`
  const fx = /^(?:fx:([a-z0-9]{2,12})|([a-z]{1,6}\d{2,3}))$/i.exec(text)
  if (fx) return `fx:${(fx[1] ?? fx[2]).toUpperCase()}`
  const m = /^(?:perpl:)?([a-z0-9]{2,10})$/i.exec(text)
  if (!m) throw invalid('market', `"${raw}" is not a market symbol.`, 'Use a Perpl perp (BTC, ETH, SOL, MON, HYPE, ZEC, LIT or PUMP) or a MonFunded liquidity instrument (EURUSD, EURGBP, XAUUSD, GER30, …).')
  return `perpl:${m[1].toUpperCase()}`
}

export function parseSide(raw: string): Side {
  const side = raw.trim().toLowerCase()
  if (side !== 'long' && side !== 'short') throw invalid('side', `"${raw}" is not a side.`, 'Use long (profits when the price rises) or short (profits when it falls).')
  return side
}

// Dollars with at most two decimals, at least `min`.
export function parseUsd(flag: string, raw: string, min: number): number {
  const text = raw.trim()
  const usd = /^\d{1,9}(\.\d{1,2})?$/.test(text) ? Number(text) : NaN
  if (!(usd >= min)) throw invalid(flag, `"${raw}" is not an amount of at least $${min}.`, 'Pass dollars as a plain number with at most two decimals, e.g. 250 or 99.50.')
  return usd
}

// Leverage from 1x to 100x, at most two decimals (the plan and Perpl cap it lower; see coach).
export function parseLeverage(raw: string): number {
  const text = raw.trim().replace(/x$/i, '')
  const leverage = /^\d{1,3}(\.\d{1,2})?$/.test(text) ? Number(text) : NaN
  if (!(leverage >= 1 && leverage <= 100)) throw invalid('leverage', `"${raw}" is not a leverage.`, 'Pass a number from 1 to the market’s cap, e.g. 2 or 3.5.')
  return leverage
}

// 32 bytes as 0x hex: account ids, withdrawal ids, transaction hashes.
export function parseHash32(flag: string, raw: string): `0x${string}` {
  const text = raw.trim()
  if (!/^0x[0-9a-f]{64}$/i.test(text)) throw invalid(flag, `"${raw}" is not a 0x id of 64 hex characters.`, 'Copy it from `mm monfunded status`.')
  return text.toLowerCase() as `0x${string}`
}

// A position id: p and 12 hex characters.
export function parsePositionId(raw: string): string {
  const text = raw.trim()
  if (!/^p[0-9a-f]{12}$/i.test(text)) throw invalid('position', `"${raw}" is not a position id.`, 'Position ids look like p1a2b3c4d5e6f; copy one from `mm monfunded status`.')
  return text.toLowerCase()
}

// The MonFunded API origin: monfunded.com unless MONFUNDED_API_URL names another server, which
// must be https, or http on this machine (a local test server), and an origin only. Another server
// is a developer's, trusted as it is (its contract too), so it is refused unless `dev` (the
// MONFUNDED_DEV=1 flag) says that is meant.
export function apiBase(raw: string | undefined, dev = false): { base: string; overridden: boolean } {
  if (raw === undefined || raw.trim() === '') return { base: DEFAULT_API, overridden: false }
  const refuse = (why: string) => new PluginError('INVALID_API_URL', `${API_URL_ENV} ${why}: "${raw}".`, `Unset ${API_URL_ENV} to use ${DEFAULT_API}, or set it to a server origin such as http://localhost:4417 (with ${DEV_ENV}=1).`)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw refuse('is not a URL')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw refuse('must use https (plain http only on localhost)')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw refuse('must be an origin only (no path, query or credentials)')
  if (url.origin === DEFAULT_API) return { base: DEFAULT_API, overridden: false }
  if (!dev)
    throw new PluginError(
      'INVALID_API_URL',
      `${API_URL_ENV} points the plugin at ${url.origin}, but it trusts only ${DEFAULT_API} unless the developer flag is set: another server decides which contract gets paid.`,
      `Unset ${API_URL_ENV} to use ${DEFAULT_API}. To test against your own server, also set ${DEV_ENV}=1, and never with real funds.`,
    )
  return { base: url.origin, overridden: true }
}

// The developer flag: MONFUNDED_DEV=1 exactly.
const devFlag = (env: Record<string, string | undefined>) => env[DEV_ENV] === '1'

// The API every command talks to, from the environment: monfunded.com with the plugin's pins, or,
// with MONFUNDED_DEV=1 and MONFUNDED_API_URL, a developer's server whose configuration (its
// contract, its MON book) is trusted as it is (`dev`). The flag is announced through `warn` on
// every command, loudly, whether or not it changes anything.
export function apiTarget(env: Record<string, string | undefined>, warn: (line: string) => void): { base: string; dev: boolean } {
  const flag = devFlag(env)
  const { base, overridden } = apiBase(env[API_URL_ENV], flag)
  if (flag) {
    const bar = '!'.repeat(78)
    const lines = overridden
      ? [
          `${DEV_ENV}=1: DEVELOPER MODE. The plugin talks to ${base}, not ${DEFAULT_API},`,
          'and trusts that server as it is: whatever contract and MON book it names get paid.',
          'Use it only with a test server and test funds, never with real money.',
        ]
      : [`${DEV_ENV}=1 is set, but ${API_URL_ENV} isn't: the plugin talks to ${DEFAULT_API}`, 'with its usual pins (the contract, the MON book, Monad). Unset the flag if you did not mean it.']
    for (const line of [bar, ...lines, bar]) warn(line)
  }
  return { base, dev: overridden }
}
