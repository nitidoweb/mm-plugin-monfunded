// The MonFunded Challenge API (server/challenge-api.md): JSON under /challenge, a wallet-signature
// sign-in that sets an httpOnly session cookie, which the plugin keeps and sends back itself. The
// cookie never leaves this module except into the session store.
import { isAddress } from 'viem'
import { AUSD, MON_MARKET, MONFUNDED_CONTRACT, REQUEST_TIMEOUT_MS, USDC, USER_AGENT } from './constants.ts'
import { apiError, PluginError, type ErrorExtras } from './errors.ts'
import type { Address, Challenge, ChallengeConfig, ClaimProof, Hex, Me, PayoutToken, Position, Prices, Side, Withdrawal } from './types.ts'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

// `dev`: a developer's server (MONFUNDED_DEV=1 with MONFUNDED_API_URL), whose contract and MON book
// are trusted as they are. Otherwise the config must name the pinned ones: `pinnedContract`
// (MONFUNDED_CONTRACT unless a test says otherwise) and Kuru's MON_USDC book.
export type ApiOptions = { dev?: boolean; pinnedContract?: Address }

// The server's session cookie (server/challenge.mjs). The __Host- prefix is the browser's rule;
// here it is only the name the server reads back.
const COOKIE = '__Host-monfunded_session'
// The API's answers are small; anything bigger is not MonFunded.
const MAX_BODY = 2_000_000

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isHexOf = (v: unknown, bytes: number): v is Hex => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)

const untrusted = (why: string) => new PluginError('BAD_CONFIG', `The MonFunded API sent a configuration the plugin does not trust (${why}).`, 'Nothing was signed. Open a support ticket in the MonFunded dashboard (https://monfunded.com/app/#support); if MONFUNDED_API_URL is set, check it points at MonFunded.')

// The config drives payments, so its money fields are checked before anything is signed: the two
// coins MonFunded uses, plans with a contract index and a positive fee, and, unless `dev`, the
// pinned contract (or none, while entries are closed) and the pinned MON book (or none). A
// developer's server may name any well-formed contract and book.
function checkConfig(sent: ChallengeConfig, { dev = false, pinnedContract = MONFUNDED_CONTRACT }: ApiOptions): ChallengeConfig {
  const tiersOk = Array.isArray(sent?.tiers) && sent.tiers.every((t) => isWord(t.id) && Number.isInteger(t.index) && t.index >= 0 && t.index <= 255 && t.feeUsd > 0 && t.size > 0 && typeof t.rules === 'object')
  if (!tiersOk) throw untrusted('malformed plans')
  // A plan's name is shown in the payment and in MetaMask's request: a short plain one, or the size.
  const c: ChallengeConfig = { ...sent, tiers: sent.tiers.map(({ name, ...t }) => ({ ...t, ...(typeof name === 'string' && PLAN_NAME.test(name) && { name }) })) }
  if (typeof c.usdc !== 'string' || typeof c.ausd !== 'string' || !sameAddress(c.usdc, USDC) || !sameAddress(c.ausd, AUSD)) throw untrusted('coins other than MonFunded’s USDC and AUSD')
  if (!(c.contract === null || (typeof c.contract === 'string' && isAddress(c.contract))) || !(c.monMarket === null || (typeof c.monMarket === 'string' && isAddress(c.monMarket)))) throw untrusted('a malformed contract or MON book')
  if (dev) return c
  if (c.monMarket !== null && !sameAddress(c.monMarket, MON_MARKET)) throw untrusted(`a MON book, ${c.monMarket}, other than Kuru’s MON_USDC book ${MON_MARKET}`)
  if (c.contract === null) return c
  if (!sameAddress(c.contract, pinnedContract)) throw untrusted(`a contract, ${c.contract}, other than MonFunded’s ${pinnedContract}`)
  return c
}

function checkProof(p: ClaimProof): ClaimProof {
  if (!isHexOf(p?.logRoot, 32) || !isHexOf(p?.signature, 65) || (p.token !== 'USDC' && p.token !== 'AUSD')) throw new PluginError('BAD_PROOF', 'The MonFunded API sent a claim proof the plugin can’t use.', 'Nothing was signed. Try again in a minute.')
  return p
}

// Accounts are read strictly, here where they come in: their words end up in refusals and summaries
// a person or an AI agent reads, so an id, a market, a side, a status or a coin must be one — never
// a sentence. Words that only describe (who closed a position, why an account failed, a payout's
// transaction) are dropped when they are not the known ones, so a value a newer server adds reads
// as absent rather than breaking the plugin.
const unreadable = (what: string) => new PluginError('BAD_RESPONSE', `The MonFunded API sent ${what} the plugin can’t read.`, 'Nothing was signed. Try again in a moment; if it keeps happening, check for a newer version of the plugin.')
const isWord = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9:_.-]{1,40}$/.test(v)
const PLAN_NAME = /^[A-Za-z0-9 $,.]{1,24}$/
const POSITION_STATUS: ReadonlySet<unknown> = new Set(['pending', 'open', 'closing', 'closed', 'cancelled'])
const CLOSED_BY: ReadonlySet<unknown> = new Set(['trader', 'liquidation', 'stopOut', 'end', 'guard', 'sl', 'tp'])
const ACCOUNT_STATUS: ReadonlySet<unknown> = new Set(['assessment', 'funded', 'failed'])
const FAIL_REASON: ReadonlySet<unknown> = new Set(['dailyLoss', 'maxDrawdown', 'conduct'])
const WITHDRAWAL_STATUS: ReadonlySet<unknown> = new Set([undefined, 'review', 'rejected', 'queued'])

function checkPosition(p: Position): Position {
  if (!p || !isWord(p.id) || !isWord(p.marketId) || (p.side !== 'long' && p.side !== 'short') || !POSITION_STATUS.has(p.status)) throw unreadable('a position')
  const { closedBy, ...rest } = p
  return { ...rest, ...(CLOSED_BY.has(closedBy) && { closedBy }) }
}

function checkWithdrawal(w: Withdrawal): Withdrawal {
  if (!w || !isHexOf(w.id, 32) || (w.token !== 'USDC' && w.token !== 'AUSD') || !WITHDRAWAL_STATUS.has(w.status)) throw unreadable('a withdrawal')
  const { tx, ...rest } = w
  return { ...rest, ...(isHexOf(tx, 32) && { tx }) }
}

function checkChallenge(c: Challenge): Challenge {
  if (!c || !isHexOf(c.id, 32) || typeof c.trader !== 'string' || !isAddress(c.trader) || !isWord(c.tier) || !ACCOUNT_STATUS.has(c.status) || !Array.isArray(c.positions) || !Array.isArray(c.withdrawals) || typeof c.progress !== 'object' || c.progress === null || typeof c.rules !== 'object' || c.rules === null)
    throw unreadable('an account')
  const { reason, ...rest } = c
  return { ...rest, ...(FAIL_REASON.has(reason) && { reason }), positions: c.positions.map(checkPosition), withdrawals: c.withdrawals.map(checkWithdrawal) }
}

function checkMe(m: Me): Me {
  if (!m || typeof m.address !== 'string' || !Array.isArray(m.active) || !Array.isArray(m.past)) throw unreadable('an account list')
  return { ...m, active: m.active.map(checkChallenge), past: m.past.map(checkChallenge) }
}

export class Api {
  readonly base: string
  // True for a developer's server (see ApiOptions): its config is trusted as it is.
  readonly dev: boolean
  readonly #fetch: Fetch
  readonly #signal: AbortSignal | undefined
  readonly #options: ApiOptions
  #cookie: string | undefined

  constructor(base: string, fetchFn: Fetch, signal?: AbortSignal, options: ApiOptions = {}) {
    this.base = base
    this.dev = options.dev ?? false
    this.#fetch = fetchFn
    this.#signal = signal
    this.#options = options
  }

  // Signs the next requests in with a saved session cookie.
  useSession(cookie: string) {
    this.#cookie = cookie
  }

  async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.#cookie) headers.cookie = `${COOKIE}=${this.#cookie}`
    let res: Response
    try {
      // A redirect is refused rather than followed: the session cookie goes to the configured
      // origin and nowhere else.
      res = await this.#fetch(`${this.base}/challenge${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' })
    } catch (e) {
      if (this.#signal?.aborted) throw new PluginError('ABORTED', 'Stopped before MonFunded answered.', 'Run the command again.')
      const why = timeout.aborted ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : e instanceof Error ? e.message : String(e)
      throw new PluginError('NETWORK', `Could not reach ${this.base} (${why}).`, 'Check the connection (and MONFUNDED_API_URL if you set it), then try again.')
    }
    const text = await res.text()
    let data: unknown
    try {
      if (text.length > MAX_BODY) throw new Error('too large')
      data = JSON.parse(text)
    } catch {
      const blocked = res.status === 403 || res.status === 503 ? ' (a firewall such as Cloudflare may be challenging command-line clients)' : ''
      throw new PluginError('NOT_JSON', `${this.base} answered HTTP ${res.status} with something other than MonFunded’s JSON${blocked}.`, 'Try again later; if it keeps happening, open a support ticket in the MonFunded dashboard (https://monfunded.com/app/#support).')
    }
    if (!res.ok) {
      const e = (data && typeof data === 'object' ? data : {}) as { error?: unknown } & ErrorExtras
      throw apiError(res.status, typeof e.error === 'string' ? e.error : undefined, e)
    }
    return { data: data as T, headers: res.headers }
  }

  // ---- sign-in ----

  // A sign-in nonce for `address` and the EIP-4361 message to sign with it; the caller checks every
  // field of the message before signing it (login.ts).
  async nonce(address: Address): Promise<{ nonce: string; message: string }> {
    const { data } = await this.#call<{ nonce?: unknown; message?: unknown }>('POST', '/auth/nonce', { address })
    if (typeof data.message !== 'string' || typeof data.nonce !== 'string') throw new PluginError('BAD_RESPONSE', 'The MonFunded API sent no sign-in message.', 'Try again in a moment.')
    return { nonce: data.nonce, message: data.message }
  }

  // Trades the signature (and the nonce it signed, which is single-use) for a session: its cookie
  // and when it expires.
  async verify(address: Address, nonce: string, signature: Hex): Promise<{ cookie: string; expiresAt: number }> {
    const { data, headers } = await this.#call<{ address?: unknown }>('POST', '/auth/verify', { address, nonce, signature })
    const line = headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? ''
    const cookie = new RegExp(`^${COOKIE}=([0-9a-f]{64})`).exec(line)?.[1]
    const maxAge = Number(/Max-Age=(\d+)/i.exec(line)?.[1] ?? NaN)
    if (!cookie || typeof data.address !== 'string' || !sameAddress(data.address, address) || !(maxAge > 0)) throw new PluginError('BAD_RESPONSE', 'MonFunded accepted the signature but sent no usable session.', 'Run `mm monfunded login` again.')
    this.#cookie = cookie
    return { cookie, expiresAt: Date.now() + maxAge * 1000 }
  }

  // ---- public ----

  async config(): Promise<ChallengeConfig> {
    return checkConfig((await this.#call<ChallengeConfig>('GET', '/config')).data, this.#options)
  }

  async prices(): Promise<Prices> {
    return (await this.#call<Prices>('GET', '/prices')).data
  }

  // ---- the signed-in wallet's accounts ----

  async me(): Promise<Me> {
    return checkMe((await this.#call<Me>('GET', '/me')).data)
  }

  async enter(tier: string, entryTx: Hex): Promise<Challenge> {
    return checkChallenge((await this.#call<Challenge>('POST', '/enter', { tier, entryTx })).data)
  }

  async account(id: string): Promise<Challenge> {
    return checkChallenge((await this.#call<Challenge>('GET', `/${id}`)).data)
  }

  async history(id: string): Promise<Position[]> {
    const { positions } = (await this.#call<{ positions: Position[] }>('GET', `/${id}/history`)).data
    if (!Array.isArray(positions)) throw unreadable('a history')
    return positions.map(checkPosition)
  }

  async order(id: string, order: { marketId: string; side: Side; notional: number; leverage: number }): Promise<{ challenge: Challenge; position: Position }> {
    const { challenge, position } = (await this.#call<{ challenge: Challenge; position: Position }>('POST', `/${id}/orders`, order)).data
    return { challenge: checkChallenge(challenge), position: checkPosition(position) }
  }

  async close(id: string, positionId: string): Promise<{ challenge: Challenge; position: Position }> {
    const { challenge, position } = (await this.#call<{ challenge: Challenge; position: Position }>('POST', `/${id}/close`, { positionId })).data
    return { challenge: checkChallenge(challenge), position: checkPosition(position) }
  }

  // A payout takes the whole cycle's profit at once (2026-09-21): no amount to give any more.
  async withdraw(id: string, token: PayoutToken): Promise<{ challenge: Challenge; withdrawal: Withdrawal }> {
    const { challenge, withdrawal } = (await this.#call<{ challenge: Challenge; withdrawal: Withdrawal }>('POST', `/${id}/withdraw`, { token })).data
    return { challenge: checkChallenge(challenge), withdrawal: checkWithdrawal(withdrawal) }
  }

  async claimProof(id: string, withdrawalId: string): Promise<ClaimProof> {
    return checkProof((await this.#call<ClaimProof>('GET', `/${id}/withdrawals/${withdrawalId}/claim`)).data)
  }
}
