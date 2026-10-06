// `mm monfunded login`: MonFunded's wallet-signature sign-in. The server's nonce message is signed
// with the active wallet through MetaMask (personal_sign), traded for a 7-day session cookie, and
// the cookie is kept in the plugin's own session file. Only MonFunded's sign-in is ever signed: an
// EIP-4361 (Sign-In with Ethereum) message for this API's own domain and origin, the active wallet,
// Monad and the nonce the server just gave, issued now and valid for minutes. Every field is
// checked and the message must be exactly what those fields render; anything else from the server
// is refused unsigned.
import { getAddress } from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import { CHAIN_ID, SIGN_IN_MAX_TTL_MS, SIGN_IN_SKEW_MS, SIGN_IN_STATEMENT } from './constants.ts'
import type { Deps } from './context.ts'
import { PluginError } from './errors.ts'
import type { Address } from './types.ts'

const NONCE = /^[0-9a-f]{32}$/

export type SignInExpectation = { base: string; wallet: Address; nonce: string; now: number }

// Why `message` is not MonFunded's sign-in for `wallet` on the API at `base` with `nonce`, at `now`;
// undefined when it is.
export function signInProblem(message: string, expected: SignInExpectation): string | undefined {
  if (!NONCE.test(expected.nonce)) return 'the nonce the server gave is not 32 hex characters'
  const api = new URL(expected.base)
  const m = parseSiweMessage(message)
  if (m.domain === undefined || m.address === undefined) return 'it is not an EIP-4361 sign-in message'
  if (m.scheme !== undefined || m.domain !== api.host) return `it is for ${m.scheme ? `${m.scheme}://` : ''}${m.domain}, not ${api.host}`
  if (m.uri !== api.origin) return `its URI is not ${api.origin}`
  if (m.address.toLowerCase() !== expected.wallet.toLowerCase()) return `it signs in ${m.address}, not the active wallet ${expected.wallet}`
  if (m.chainId !== CHAIN_ID) return `it is for chain ${m.chainId ?? 'none'}, not Monad (${CHAIN_ID})`
  if (m.version !== '1') return 'its version is not 1'
  if (m.statement !== SIGN_IN_STATEMENT) return `its statement is not “${SIGN_IN_STATEMENT}”`
  if (m.nonce !== expected.nonce) return 'its nonce is not the one the server gave'
  if (m.notBefore !== undefined || m.requestId !== undefined || m.resources !== undefined) return 'it carries fields MonFunded’s sign-in never has (a not-before time, a request id or resources)'
  const issued = m.issuedAt?.getTime()
  if (issued === undefined || !Number.isFinite(issued) || Math.abs(issued - expected.now) > SIGN_IN_SKEW_MS) return `its issue time is more than ${SIGN_IN_SKEW_MS / 60_000} minutes from this computer’s clock`
  const expires = m.expirationTime?.getTime()
  if (expires === undefined || !Number.isFinite(expires)) return 'it has no expiration time'
  if (expires <= expected.now) return 'it has expired'
  if (expires <= issued || expires - issued > SIGN_IN_MAX_TTL_MS) return `it stays valid more than ${SIGN_IN_MAX_TTL_MS / 60_000} minutes`
  let rendered: string
  try {
    rendered = createSiweMessage({ domain: m.domain, address: getAddress(m.address), statement: m.statement, uri: m.uri, version: '1', chainId: m.chainId, nonce: m.nonce, issuedAt: m.issuedAt, expirationTime: m.expirationTime })
  } catch {
    return 'it is not a well-formed EIP-4361 message'
  }
  if (rendered !== message) return 'it is not exactly MonFunded’s sign-in (extra or reformatted text)'
  return undefined
}

export type LoginResult = { signedIn: true; wallet: Address; api: string; expiresAt: string; sessionFile: string; activeAccounts: number; summary: string[] }

export async function login(d: Deps): Promise<LoginResult> {
  // Sent along with the sign-in, so the server retires the previous session as it starts this one.
  const previous = d.store.get(d.api.base, d.now())
  if (previous) d.api.useSession(previous.cookie)
  const { nonce, message } = await d.api.nonce(d.wallet)
  const problem = signInProblem(message, { base: d.api.base, wallet: d.wallet, nonce, now: d.now() })
  if (problem) throw new PluginError('UNEXPECTED_MESSAGE', `The server asked to sign something other than MonFunded’s sign-in for this wallet on ${d.api.base}: ${problem}. Nothing was signed.`, 'Check this computer’s clock, and if MONFUNDED_API_URL is set, that it points at MonFunded; then run `mm monfunded login` again.')
  const signer = await d.signer()
  const signature = await signer.signMessage(message, `Sign in to MonFunded (${new URL(d.api.base).host}) as ${d.wallet}`)
  const { cookie, expiresAt } = await d.api.verify(d.wallet, nonce, signature)
  d.store.save(d.api.base, { address: d.wallet, cookie, expiresAt })
  const me = await d.api.me()
  const until = new Date(expiresAt).toISOString()
  return {
    signedIn: true,
    wallet: d.wallet,
    api: d.api.base,
    expiresAt: until,
    sessionFile: d.store.file,
    activeAccounts: me.active.length,
    summary: [
      `Signed in to MonFunded (${d.api.base}) as ${d.wallet} until ${until}.`,
      `The session is kept in ${d.store.file}, readable by this user only.`,
      me.active.length ? `${me.active.length} running account${me.active.length > 1 ? 's' : ''}: see \`mm monfunded status\`.` : 'No account yet: see the plans with `mm monfunded status`, then `mm monfunded buy`.',
    ],
  }
}
