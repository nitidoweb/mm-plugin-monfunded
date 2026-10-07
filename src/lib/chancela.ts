// Chancela (chancela.xyz) in front of the plugin's transfers, when the operator asks for it. Before
// the wallet signs anything that moves money — the fee that buys an assessment, the claim that
// takes a payout — the plugin asks Chancela whether its agent may make that exact transfer, checks
// the signed answer on this machine against the attestor from its own settings (never the address
// the server names for itself), and signs only on a verified ALLOW. A transfer is CRITICAL under
// Chancela's registry, so the usual answer is REQUIRE_APPROVAL: the agent's owner approves it with a
// passkey in Chancela's dashboard, and the plugin waits for the signed ALLOW that follows, or for the
// request to expire. A refusal, a declined or lapsed approval, an unreachable deployment or an answer
// that does not verify all mean the same thing: nothing is signed.
//
// Three settings turn it on: MONFUNDED_CHANCELA_AGENT (the agent's id), MONFUNDED_CHANCELA_ATTESTOR
// (the address whose signature counts) and, for a deployment of one's own, MONFUNDED_CHANCELA_URL.
import { createClient, type ChancelaClient, type Decision } from 'chancela-sdk'
import { getAddress, isAddress, type Address } from 'viem'
import { PluginError } from './errors.ts'

export const AGENT_ENV = 'MONFUNDED_CHANCELA_AGENT'
export const ATTESTOR_ENV = 'MONFUNDED_CHANCELA_ATTESTOR'
export const URL_ENV = 'MONFUNDED_CHANCELA_URL'
export const DEFAULT_URL = 'https://chancela.xyz'
export const ACTION = 'TRANSFER_FUNDS'
// An answer later than this is no answer: the command must not hang on a server that trickles bytes.
export const ANSWER_TIMEOUT_MS = 8_000
// How often the plugin looks for the owner's decision while an approval is pending, and the most
// it waits whatever the server says the request's window is.
export const POLL_MS = 5_000
export const MAX_WAIT_MS = 15 * 60_000
// An answer bigger than this is not an answer (a decision is ~2 KB).
export const MAX_BODY_BYTES = 64 * 1024
// A capsule must be fresh: issued for this request (not one captured earlier) and short-lived.
export const MAX_CAPSULE_AGE_S = 60
export const MAX_CAPSULE_LIFE_S = 20 * 60

export type ChancelaSettings = { agentId: string; baseUrl: string; attestor: Address }

// A transfer as the plugin describes it to Chancela: whole dollars and cents, who receives it and,
// when known, at which address, and a memo naming the plan or the withdrawal.
export type Transfer = { amountUsd: number; recipient: string; recipientAddress?: Address; memo: string }

// What a verified ALLOW leaves behind: enough to find and replay the decision.
export type Receipt = { auditId: string; policyVersion: number }

// Resolves on a verified ALLOW; throws a PluginError for every other outcome.
export type Gate = (transfer: Transfer) => Promise<Receipt>

// The settings, or undefined when none is set. Half a setting is an error, never a gate turned off
// in silence; plain http only to this machine.
export function chancelaSettings(env: Record<string, string | undefined>): ChancelaSettings | undefined {
  const agentId = env[AGENT_ENV]?.trim()
  const attestor = env[ATTESTOR_ENV]?.trim()
  const rawUrl = env[URL_ENV]?.trim()
  if (!agentId) {
    const stray = [attestor && ATTESTOR_ENV, rawUrl && URL_ENV].filter(Boolean)
    if (stray.length) throw new PluginError('CHANCELA_MISCONFIGURED', `${stray.join(' and ')} set, but ${AGENT_ENV} is empty.`, `Name the agent in ${AGENT_ENV}, or unset all three to run without Chancela.`)
    return undefined
  }
  if (!/^[\w.-]{1,64}$/.test(agentId)) throw new PluginError('CHANCELA_MISCONFIGURED', `${AGENT_ENV} is not an agent id: "${agentId.slice(0, 80)}".`, 'An agent id looks like TA-006.')
  if (!attestor || !isAddress(attestor)) throw new PluginError('CHANCELA_MISCONFIGURED', `${AGENT_ENV} is set, so ${ATTESTOR_ENV} must be the address whose signature counts (0x…, 40 hex).`, 'Without it no answer could be checked, and every transfer would be refused. Chancela shows the attestor on the agent’s page.')
  const baseUrl = (rawUrl || DEFAULT_URL).replace(/\/+$/, '')
  let url: URL | undefined
  try {
    url = new URL(baseUrl)
  } catch {
    url = undefined
  }
  const local = url && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  if (!url || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new PluginError('CHANCELA_MISCONFIGURED', `${URL_ENV} must be an https URL (http only for localhost): "${baseUrl.slice(0, 80)}".`, `Unset it to use ${DEFAULT_URL}.`)
  return { agentId, baseUrl, attestor: getAddress(attestor) }
}

// Text the server chose, before it reaches the terminal or a log: printable, and short.
const quoted = (text: unknown) => String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, 160)

export function transferParameters(t: Transfer): Record<string, unknown> {
  return {
    amount: Math.max(1, Math.ceil(t.amountUsd * 100)),
    currency: 'USD',
    recipient: t.recipient,
    ...(t.recipientAddress !== undefined && { recipientAddress: t.recipientAddress }),
    memo: t.memo,
  }
}

type Approval = { id: string; status: string; expiresAt: string; url?: string }
type ApprovalState = { approval?: { status?: string; expiresAt?: string; decision?: unknown } }
const APPROVAL_ID = /^[\w-]{1,64}$/

// fetch with a deadline and a ceiling on the body: the SDK reads whatever comes back whole, and a
// server that answered 300 MB inside the deadline would take the process down with it.
export const boundedFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) })
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw Object.assign(new Error(`Chancela answered more than ${MAX_BODY_BYTES} bytes.`), { code: 'OVERSIZED' })
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    body.set(c, at)
    at += c.byteLength
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

export type GateOptions = {
  fetch?: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  // A line for the person at the terminal (nothing in JSON mode).
  say: (line: string) => void
  client?: ChancelaClient
}

const unreachable = (settings: ChancelaSettings, e: unknown) => {
  const code = e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : 'UNREACHABLE'
  return new PluginError(`CHANCELA_${/^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNREACHABLE'}`, `Chancela (${settings.baseUrl}) gave no usable answer for agent ${settings.agentId} (${quoted(code)}: ${quoted(e instanceof Error ? e.message : e)}). Nothing was signed.`, 'No answer is never permission. Check the agent on chancela.xyz (a burst of refusals suspends it), then run the command again.')
}

export function chancelaGate(settings: ChancelaSettings, o: GateOptions): Gate {
  const doFetch: typeof fetch = o.fetch ?? boundedFetch
  const nowSec = () => Math.floor(o.now() / 1000)
  const client = o.client ?? createClient({ baseUrl: settings.baseUrl, attestor: settings.attestor, fetch: doFetch, now: nowSec })
  const where = `${settings.baseUrl.replace(/^https?:\/\//, '')}`
  const unverified = (code: string, detail?: string) => new PluginError(`CHANCELA_UNVERIFIED_${code}`, `Chancela’s permission did not verify on this machine (${code}${detail ? `: ${quoted(detail)}` : ''}). Nothing was signed.`, `The answer was checked against ${settings.attestor} (${ATTESTOR_ENV}); if Chancela rotated its attestor, update the setting. Otherwise do not retry blindly: someone may be answering for Chancela.`)

  // The SDK checks the signature, the intent and that the capsule has not expired. The plugin adds
  // freshness: the capsule was issued for this request (not captured from an earlier one and
  // replayed), and it does not live for hours — the SDK alone would take a missing or non-numeric
  // expiry as "never expires".
  const verified = async (decision: Decision, parameters: Record<string, unknown>, requestedAt: number): Promise<Receipt> => {
    const { capsule } = decision
    if (typeof capsule?.issuedAt !== 'number' || typeof capsule.expiresAt !== 'number' || !Number.isFinite(capsule.issuedAt) || !Number.isFinite(capsule.expiresAt)) throw unverified('MALFORMED', 'the capsule has no numeric issuedAt/expiresAt')
    if (capsule.issuedAt < requestedAt - MAX_CAPSULE_AGE_S) throw unverified('STALE', `the capsule was issued ${requestedAt - capsule.issuedAt} s before this request`)
    if (capsule.expiresAt - capsule.issuedAt > MAX_CAPSULE_LIFE_S) throw unverified('LONG_LIVED', `the capsule lives ${capsule.expiresAt - capsule.issuedAt} s`)
    const verdict = await client.verify(decision, { agentId: settings.agentId, action: ACTION, parameters })
    if (!verdict.ok) throw unverified(verdict.code, verdict.detail)
    const receipt: Receipt = { auditId: quoted(decision.auditId), policyVersion: Number(capsule.policyVersion) }
    o.say(`Chancela: ALLOW for agent ${settings.agentId} (policy v${quoted(capsule.policyVersion)}, audit ${receipt.auditId}) — replay it with \`npx chancela-check replay ${receipt.auditId}\`.`)
    return receipt
  }

  // After REQUIRE_APPROVAL: the owner's decision, polled at the public approval route until it is
  // made or the request lapses. The decision there is a signed capsule for the same intent, and
  // it goes through the same verification as a direct ALLOW.
  const awaitApproval = async (approval: Approval, parameters: Record<string, unknown>, requestedAt: number): Promise<Receipt> => {
    // The server's window, but never longer than ours: the wait must end whatever it says.
    const deadline = Date.parse(String(approval.expiresAt))
    const until = Math.min(Number.isFinite(deadline) ? deadline : Infinity, o.now() + MAX_WAIT_MS)
    o.say(`Chancela asks the agent’s owner to approve this transfer first: open ${settings.baseUrl} → Approvals → request ${approval.id}, and approve it with your passkey before ${new Date(until).toISOString().replace('T', ' ').slice(0, 16)} UTC.`)
    o.say(`Waiting for the decision (every ${POLL_MS / 1000} s, up to ${Math.max(0, Math.round((until - o.now()) / 60_000))} min). Ctrl-C leaves the request pending; nothing is signed without it.`)
    for (;;) {
      let state: ApprovalState
      try {
        const res = await doFetch(`${settings.baseUrl}/api/approvals/${encodeURIComponent(approval.id)}`, { headers: { accept: 'application/json' } })
        if (!res.ok) throw Object.assign(new Error(`Chancela answered ${res.status} at the approval route.`), { code: `HTTP_${res.status}` })
        const json: unknown = await res.json()
        if (!json || typeof json !== 'object') throw Object.assign(new Error('The approval route answered something other than an object.'), { code: 'MALFORMED' })
        state = json as ApprovalState
      } catch (e) {
        throw unreachable(settings, e)
      }
      const status = String(state.approval?.status ?? 'PENDING').toUpperCase()
      const decision = state.approval?.decision
      if (decision && typeof decision === 'object' && 'capsule' in decision && 'signature' in decision) {
        const d = decision as Decision
        if (d.decision !== 'ALLOW') throw new PluginError('CHANCELA_DECLINED', `The owner declined this transfer in Chancela (${quoted(d.reasonCode)}). Nothing was signed.`, 'A declined request is final; make a new one by running the command again if that is really wanted.')
        return verified(d, parameters, requestedAt)
      }
      // Approved but the signed decision not attached yet: keep asking until it is, or the window ends.
      if (status !== 'PENDING' && status !== 'APPROVED') throw new PluginError(status === 'EXPIRED' ? 'CHANCELA_APPROVAL_EXPIRED' : 'CHANCELA_DECLINED', `Chancela’s approval request ${approval.id} ended as ${quoted(status)} without an ALLOW. Nothing was signed.`, status === 'EXPIRED' ? 'Run the command again and approve the new request in Chancela within its window.' : 'A declined request is final; run the command again only if the transfer is really wanted.')
      if (o.now() >= until) throw new PluginError('CHANCELA_APPROVAL_EXPIRED', `Chancela’s approval request ${approval.id} was not approved before it expired. Nothing was signed.`, 'Run the command again and approve the new request in Chancela within its window.')
      await o.sleep(POLL_MS)
    }
  }

  return async (transfer) => {
    const parameters = transferParameters(transfer)
    const requestedAt = nowSec()
    let decision: Decision
    try {
      decision = await client.authorize(settings.agentId, ACTION, parameters)
    } catch (e) {
      throw unreachable(settings, e)
    }
    if (decision.decision === 'ALLOW') return verified(decision, parameters, requestedAt)
    if (decision.decision === 'REQUIRE_APPROVAL') {
      // The request id is the server's and unsigned: it goes into a URL and onto the terminal, so
      // it is an identifier or nothing.
      const approval = (decision as Decision & { approval?: Partial<Approval> }).approval
      if (!approval || typeof approval.id !== 'string' || !APPROVAL_ID.test(approval.id)) throw new PluginError('CHANCELA_MALFORMED', `Chancela (${where}) asked for an approval but named no usable request to wait on. Nothing was signed.`, 'Try again in a minute; if it repeats, the Chancela deployment is at fault.')
      return awaitApproval(approval as Approval, parameters, requestedAt)
    }
    throw new PluginError('CHANCELA_DENIED', `Chancela refused this transfer for agent ${settings.agentId}: ${quoted(decision.reasonCode)} — ${quoted(decision.reasonText)} (audit ${quoted(decision.auditId)}). Nothing was signed.`, `The agent’s policy on ${where} sets what it may move per transfer and per day; a refusal is recorded there and on Monad.`)
  }
}
