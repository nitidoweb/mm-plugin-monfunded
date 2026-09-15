// The MonFunded Challenge API (server/challenge-api.md): JSON under /challenge, a wallet-signature
// sign-in that sets an httpOnly session cookie, which the plugin keeps and sends back itself. The
// cookie never leaves this module except into the session store.
import { isAddress } from 'viem'
import { AUSD, DEV_ENV, MON_MARKET, MONFUNDED_CONTRACT, REQUEST_TIMEOUT_MS, USDC, USER_AGENT } from './constants.ts'
import { apiError, PluginError, type ErrorExtras } from './errors.ts'
import type { Address, Challenge, ChallengeConfig, ClaimProof, Hex, Me, PayoutToken, Position, Prices, Side, Withdrawal } from './types.ts'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

// `dev`: a developer's server (MONFUNDED_DEV=1 with MONFUNDED_API_URL), whose contract and MON book
// are trusted as they are. Otherwise the config must name the pinned ones: `pinnedContract`
// (MONFUNDED_CONTRACT unless a test says otherwise) and Kuru's MON_USDC book.
export type ApiOptions = { dev?: boolean; pinnedContract?: Address | null }

const COOKIE = 'monfunded_session'
// The API's answers are small; anything bigger is not MonFunded.
const MAX_BODY = 2_000_000

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isHexOf = (v: unknown, bytes: number): v is Hex => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)

const untrusted = (why: string) => new PluginError('BAD_CONFIG', `The MonFunded API sent a configuration the plugin does not trust (${why}).`, 'Nothing was signed. Tell MonFunded on Telegram (https://t.me/monfunded); if MONFUNDED_API_URL is set, check it points at MonFunded.')

// The config drives payments, so its money fields are checked before anything is signed: the two
// coins MonFunded uses, plans with a contract index and a positive fee, and, unless `dev`, the
// pinned contract (or none yet) and the pinned MON book (or none). A developer's server may name
// any well-formed contract and book.
function checkConfig(c: ChallengeConfig, { dev = false, pinnedContract = MONFUNDED_CONTRACT }: ApiOptions): ChallengeConfig {
  const tiersOk = Array.isArray(c?.tiers) && c.tiers.every((t) => typeof t.id === 'string' && Number.isInteger(t.index) && t.index >= 0 && t.index <= 255 && t.feeUsd > 0 && t.size > 0 && typeof t.rules === 'object')
  if (!tiersOk) throw untrusted('malformed plans')
  if (typeof c.usdc !== 'string' || typeof c.ausd !== 'string' || !sameAddress(c.usdc, USDC) || !sameAddress(c.ausd, AUSD)) throw untrusted('coins other than MonFunded’s USDC and AUSD')
  if (!(c.contract === null || (typeof c.contract === 'string' && isAddress(c.contract))) || !(c.monMarket === null || (typeof c.monMarket === 'string' && isAddress(c.monMarket)))) throw untrusted('a malformed contract or MON book')
  if (dev) return c
  if (c.monMarket !== null && !sameAddress(c.monMarket, MON_MARKET)) throw untrusted(`a MON book, ${c.monMarket}, other than Kuru’s MON_USDC book ${MON_MARKET}`)
  if (c.contract === null) return c
  if (pinnedContract === null)
    throw new PluginError(
      'PLUGIN_OUTDATED',
      `The MonFunded API names a contract (${c.contract}), but this version of the plugin doesn’t know MonFunded’s contract yet, so it pays none and reads none.`,
      `Nothing was signed. Update the plugin (a newer mm-plugin-monfunded pins the deployed contract), or set ${DEV_ENV}=1 with MONFUNDED_API_URL only for a test server.`,
    )
  if (!sameAddress(c.contract, pinnedContract)) throw untrusted(`a contract, ${c.contract}, other than MonFunded’s ${pinnedContract}`)
  return c
}

function checkProof(p: ClaimProof): ClaimProof {
  if (!isHexOf(p?.logRoot, 32) || !isHexOf(p?.signature, 65) || (p.token !== 'USDC' && p.token !== 'AUSD')) throw new PluginError('BAD_PROOF', 'The MonFunded API sent a claim proof the plugin can’t use.', 'Nothing was signed. Try again in a minute.')
  return p
}

function checkMe(m: Me): Me {
  if (!m || typeof m.address !== 'string' || !Array.isArray(m.active) || !Array.isArray(m.past)) throw new PluginError('BAD_RESPONSE', 'The MonFunded API sent an account list the plugin can’t read.', 'Try again in a moment.')
  return m
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
      throw new PluginError('NOT_JSON', `${this.base} answered HTTP ${res.status} with something other than MonFunded’s JSON${blocked}.`, 'Try again later; if it keeps happening, tell MonFunded on Telegram (https://t.me/monfunded).')
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
    return (await this.#call<Challenge>('POST', '/enter', { tier, entryTx })).data
  }

  async account(id: string): Promise<Challenge> {
    return (await this.#call<Challenge>('GET', `/${id}`)).data
  }

  async history(id: string): Promise<Position[]> {
    return (await this.#call<{ positions: Position[] }>('GET', `/${id}/history`)).data.positions
  }

  async order(id: string, order: { marketId: string; side: Side; notional: number; leverage: number }): Promise<{ challenge: Challenge; position: Position }> {
    return (await this.#call<{ challenge: Challenge; position: Position }>('POST', `/${id}/orders`, order)).data
  }

  async close(id: string, positionId: string): Promise<{ challenge: Challenge; position: Position }> {
    return (await this.#call<{ challenge: Challenge; position: Position }>('POST', `/${id}/close`, { positionId })).data
  }

  async withdraw(id: string, amountUsd: number, token: PayoutToken): Promise<{ challenge: Challenge; withdrawal: Withdrawal }> {
    return (await this.#call<{ challenge: Challenge; withdrawal: Withdrawal }>('POST', `/${id}/withdraw`, { amountUsd, token })).data
  }

  async claimProof(id: string, withdrawalId: string): Promise<ClaimProof> {
    return checkProof((await this.#call<ClaimProof>('GET', `/${id}/withdrawals/${withdrawalId}/claim`)).data)
  }
}
