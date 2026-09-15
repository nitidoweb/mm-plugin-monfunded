// The MonFunded Challenge API (server/challenge-api.md): JSON under /challenge, a wallet-signature
// sign-in that sets an httpOnly session cookie, which the plugin keeps and sends back itself. The
// cookie never leaves this module except into the session store.
import { isAddress } from 'viem'
import { AUSD, REQUEST_TIMEOUT_MS, USDC, USER_AGENT } from './constants.ts'
import { apiError, PluginError } from './errors.ts'
import type { Address, Challenge, ChallengeConfig, ClaimProof, Hex, Me, PayoutToken, Position, Prices, Side, Withdrawal } from './types.ts'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const COOKIE = 'monfunded_session'
// The API's answers are small; anything bigger is not MonFunded.
const MAX_BODY = 2_000_000

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isHexOf = (v: unknown, bytes: number): v is Hex => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)

// The config drives payments, so its money fields are checked before anything is signed: a real
// contract address (or null), the two coins MonFunded uses, and plans with a contract index and a
// positive fee.
function checkConfig(c: ChallengeConfig): ChallengeConfig {
  const tiersOk = Array.isArray(c?.tiers) && c.tiers.every((t) => typeof t.id === 'string' && Number.isInteger(t.index) && t.index >= 0 && t.index <= 255 && t.feeUsd > 0 && t.size > 0 && typeof t.rules === 'object')
  const ok = tiersOk && (c.contract === null || isAddress(c.contract)) && (c.monMarket === null || isAddress(c.monMarket)) && sameAddress(c.usdc, USDC) && sameAddress(c.ausd, AUSD)
  if (!ok) throw new PluginError('BAD_CONFIG', 'The MonFunded API sent a configuration the plugin does not trust (unexpected coins, contract or plans).', 'Nothing was signed. If MONFUNDED_API_URL is set, check it points at MonFunded.')
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
  readonly #fetch: Fetch
  readonly #signal: AbortSignal | undefined
  #cookie: string | undefined

  constructor(base: string, fetchFn: Fetch, signal?: AbortSignal) {
    this.base = base
    this.#fetch = fetchFn
    this.#signal = signal
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
      throw new PluginError('NOT_JSON', `${this.base} answered HTTP ${res.status} with something other than MonFunded's JSON${blocked}.`, 'Try again later; if it keeps happening, tell MonFunded on Telegram (https://t.me/monfunded).')
    }
    if (!res.ok) {
      const e = data as { error?: unknown; retryAt?: unknown } | null
      throw apiError(res.status, typeof e?.error === 'string' ? e.error : undefined, typeof e?.retryAt === 'number' ? e.retryAt : undefined)
    }
    return { data: data as T, headers: res.headers }
  }

  // ---- sign-in ----

  // The message to sign for `address`; the caller checks its wording before signing it.
  async nonce(address: Address): Promise<string> {
    const { data } = await this.#call<{ message?: unknown }>('POST', '/auth/nonce', { address })
    if (typeof data.message !== 'string') throw new PluginError('BAD_RESPONSE', 'The MonFunded API sent no sign-in message.', 'Try again in a moment.')
    return data.message
  }

  // Trades the signature for a session: its cookie and when it expires.
  async verify(address: Address, signature: Hex): Promise<{ cookie: string; expiresAt: number }> {
    const { data, headers } = await this.#call<{ address?: unknown }>('POST', '/auth/verify', { address, signature })
    const line = headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? ''
    const cookie = new RegExp(`^${COOKIE}=([0-9a-f]{64})`).exec(line)?.[1]
    const maxAge = Number(/Max-Age=(\d+)/i.exec(line)?.[1] ?? NaN)
    if (!cookie || typeof data.address !== 'string' || !sameAddress(data.address, address) || !(maxAge > 0)) throw new PluginError('BAD_RESPONSE', 'MonFunded accepted the signature but sent no usable session.', 'Run `mm monfunded login` again.')
    this.#cookie = cookie
    return { cookie, expiresAt: Date.now() + maxAge * 1000 }
  }

  // ---- public ----

  async config(): Promise<ChallengeConfig> {
    return checkConfig((await this.#call<ChallengeConfig>('GET', '/config')).data)
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
