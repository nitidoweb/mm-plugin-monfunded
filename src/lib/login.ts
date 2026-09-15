// `mm monfunded login`: MonFunded's wallet-signature sign-in. The server's nonce message is signed
// with the active wallet through MetaMask (personal_sign), traded for a 7-day session cookie, and
// the cookie is kept in the plugin's own session file. Only MonFunded's exact sign-in wording is
// ever signed: anything else from the server is refused unsigned.
import type { Deps } from './context.ts'
import { PluginError } from './errors.ts'
import type { Address } from './types.ts'

const SIGN_IN = /^MonFunded Challenge\n\nSign in as (0x[0-9a-fA-F]{40})\nNonce: [0-9a-f]{32}\nIssued: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type LoginResult = { signedIn: true; wallet: Address; api: string; expiresAt: string; sessionFile: string; activeAccounts: number; summary: string[] }

export async function login(d: Deps): Promise<LoginResult> {
  // Sent along with the sign-in, so the server retires the previous session as it starts this one.
  const previous = d.store.get(d.api.base, d.now())
  if (previous) d.api.useSession(previous.cookie)
  const message = await d.api.nonce(d.wallet)
  const m = SIGN_IN.exec(message)
  if (!m || m[1].toLowerCase() !== d.wallet.toLowerCase()) throw new PluginError('UNEXPECTED_MESSAGE', 'The server asked to sign something other than MonFunded’s sign-in message for this wallet, so nothing was signed.', 'If MONFUNDED_API_URL is set, check it points at MonFunded.')
  const signer = await d.signer()
  const signature = await signer.signMessage(message, `Sign in to MonFunded as ${d.wallet}`)
  const { cookie, expiresAt } = await d.api.verify(d.wallet, signature)
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
