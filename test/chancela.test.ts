// Chancela in front of the plugin's transfers (src/lib/chancela.ts): a stand-in deployment on
// localhost answers what each test scripts and signs its capsules with a key the test holds; the
// plugin is told that key's address is the attestor. A second key stands for a deployment that lies.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buy } from '../src/lib/buy.ts'
import { ACTION, chancelaGate, chancelaSettings, POLL_MS, transferParameters, type Transfer } from '../src/lib/chancela.ts'
import { PluginError } from '../src/lib/errors.ts'
import { claim } from '../src/lib/payout.ts'
import type { Withdrawal } from '../src/lib/types.ts'
import { account, config, CONTRACT, fakeApi, makeDeps, T0, wallet } from './fakes.ts'

const attestorKey = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const impostorKey = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const AGENT = 'TA-006'

// Chancela's canonical JSON (keys sorted, no whitespace), enough for the plain objects here.
const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

type Outcome = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL'
type Script = {
  decision: Outcome
  signer?: typeof attestorKey
  parametersSeen?: Record<string, unknown>
  expiresIn?: number
  // What the approval route answers, poll by poll (the last entry repeats).
  approval?: ({ status: string; decided?: Outcome; parametersSeen?: Record<string, unknown> } | 'down')[]
  error?: { status: number; body: string }
}

async function signedDecision(script: { decision: Outcome; signer?: typeof attestorKey; parametersSeen?: Record<string, unknown>; expiresIn?: number }, agentId: string, action: string, parameters: Record<string, unknown>) {
  const intentHash = keccak256(toHex(canonical({ agentId, action, parameters: script.parametersSeen ?? parameters })))
  const now = Math.floor(Date.now() / 1000)
  const capsule = { version: 1, agentId, ownerAddress: attestorKey.address, action, intentHash, policyId: `pol_${agentId}_v4`, policyVersion: 4, policyHash: `0x${'ab'.repeat(32)}`, decision: script.decision, risk: 'CRITICAL', reasonCode: script.decision === 'ALLOW' ? 'OK' : script.decision === 'DENY' ? 'LIMIT_EXCEEDED' : 'APPROVAL_REQUIRED_AMOUNT', nonce: 'n1', issuedAt: now, expiresAt: now + (script.expiresIn ?? 60), decisionHash: `0x${'cd'.repeat(32)}` }
  const signer = script.signer ?? attestorKey
  const signature = await signer.signMessage({ message: canonical(capsule) })
  return { decisionId: 'dec_1', auditId: 'TA-AUDIT-TEST', decision: script.decision, reasonCode: capsule.reasonCode, reasonText: 'test', risk: 'CRITICAL', policyVersion: 4, policyHash: capsule.policyHash, intentHash, decisionHash: capsule.decisionHash, capsule, signature, attestationAddress: signer.address, anchorStatus: 'PENDING' }
}

async function fakeChancela(script: Script, log: { asked: Record<string, unknown>[]; polls: number }): Promise<{ server: Server; url: string }> {
  let intent: { agentId: string; action: string; parameters: Record<string, unknown> } | undefined
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && req.url?.startsWith('/api/approvals/')) {
        const step = script.approval?.[Math.min(log.polls, (script.approval?.length ?? 1) - 1)] ?? { status: 'PENDING' }
        log.polls += 1
        if (step === 'down') {
          res.statusCode = 503
          return res.end('{"error":{"code":"DOWN","message":"maintenance"}}')
        }
        const decision = step.decided && intent ? await signedDecision({ decision: step.decided, parametersSeen: step.parametersSeen }, intent.agentId, intent.action, intent.parameters) : null
        return res.end(JSON.stringify({ approval: { id: 'apr_test', status: step.status, expiresAt: new Date(T0 + 15 * 60_000).toISOString(), decision } }))
      }
      if (script.error) {
        res.statusCode = script.error.status
        return res.end(script.error.body)
      }
      const { action, parameters } = JSON.parse(body)
      const agentId = decodeURIComponent(req.url!.split('/')[3])
      intent = { agentId, action, parameters }
      log.asked.push({ agentId, action, parameters })
      const decision = await signedDecision(script, agentId, action, parameters)
      res.end(JSON.stringify(script.decision === 'REQUIRE_APPROVAL' ? { ...decision, approval: { id: 'apr_test', status: 'PENDING', expiresAt: new Date(T0 + 15 * 60_000).toISOString(), url: '/api/approvals/apr_test' } } : decision))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { server, url: `http://127.0.0.1:${port}` }
}

const FEE: Transfer = { amountUsd: 30, recipient: 'MonFunded challenge contract', recipientAddress: CONTRACT, memo: 'fee for plan tight-5k' }

// A gate against a scripted deployment, with the test's clock: sleep moves time, nothing waits.
async function gated(script: Script, attestor = attestorKey.address) {
  const log = { asked: [] as Record<string, unknown>[], polls: 0, said: [] as string[] }
  const { server, url } = await fakeChancela(script, log)
  const clock = { now: T0 }
  const gate = chancelaGate(
    { agentId: AGENT, baseUrl: url, attestor },
    {
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms
      },
      say: (line) => log.said.push(line),
    },
  )
  const run = async (transfer: Transfer = FEE) => {
    try {
      await gate(transfer)
      return undefined
    } catch (e) {
      return e as PluginError
    } finally {
      server.close()
    }
  }
  return { run, log, clock, url }
}

const code = (e: PluginError | undefined, expected: string) => {
  assert.ok(e instanceof PluginError, `expected ${expected}, got ${String(e)}`)
  assert.equal(e.code, expected, e.message)
}

test('settings: off when nothing is set, an error when half is set, https only except to localhost', () => {
  assert.equal(chancelaSettings({}), undefined)
  assert.throws(() => chancelaSettings({ MONFUNDED_CHANCELA_ATTESTOR: attestorKey.address }), /MONFUNDED_CHANCELA_AGENT is empty/)
  assert.throws(() => chancelaSettings({ MONFUNDED_CHANCELA_URL: 'https://chancela.xyz' }), /MONFUNDED_CHANCELA_AGENT is empty/)
  assert.throws(() => chancelaSettings({ MONFUNDED_CHANCELA_AGENT: AGENT }), /MONFUNDED_CHANCELA_ATTESTOR/)
  assert.throws(() => chancelaSettings({ MONFUNDED_CHANCELA_AGENT: AGENT, MONFUNDED_CHANCELA_ATTESTOR: 'nope' }), /MONFUNDED_CHANCELA_ATTESTOR/)
  assert.throws(() => chancelaSettings({ MONFUNDED_CHANCELA_AGENT: 'TA 006; rm', MONFUNDED_CHANCELA_ATTESTOR: attestorKey.address }), /not an agent id/)
  const on = (url?: string) => chancelaSettings({ MONFUNDED_CHANCELA_AGENT: AGENT, MONFUNDED_CHANCELA_ATTESTOR: attestorKey.address.toLowerCase(), ...(url !== undefined && { MONFUNDED_CHANCELA_URL: url }) })
  assert.deepEqual(on(), { agentId: AGENT, baseUrl: 'https://chancela.xyz', attestor: attestorKey.address })
  assert.equal(on('http://127.0.0.1:4321/')?.baseUrl, 'http://127.0.0.1:4321')
  assert.throws(() => on('http://chancela.xyz'), /https/)
  assert.throws(() => on('ftp://x'), /https/)
  assert.throws(() => on('not a url'), /https/)
})

test('a transfer goes to Chancela as TRANSFER_FUNDS in cents, with recipient, address and memo', () => {
  assert.deepEqual(transferParameters(FEE), { amount: 3000, currency: 'USD', recipient: 'MonFunded challenge contract', recipientAddress: CONTRACT, memo: 'fee for plan tight-5k' })
  assert.equal(transferParameters({ amountUsd: 79.995, recipient: 'x', memo: 'm' }).amount, 8000, 'rounded up')
  assert.equal('recipientAddress' in transferParameters({ amountUsd: 1, recipient: 'x', memo: 'm' }), false)
})

test('a verified ALLOW lets the transfer through and says how to replay it', async () => {
  const g = await gated({ decision: 'ALLOW' })
  assert.equal(await g.run(), undefined)
  assert.equal(g.log.asked.length, 1)
  assert.deepEqual(g.log.asked[0], { agentId: AGENT, action: ACTION, parameters: transferParameters(FEE) })
  assert.match(g.log.said.join('\n'), /Chancela: ALLOW for agent TA-006 \(policy v4, audit TA-AUDIT-TEST\).*chancela-check replay TA-AUDIT-TEST/)
})

test('DENY refuses with Chancela’s reason; nothing waits', async () => {
  const g = await gated({ decision: 'DENY' })
  const e = await g.run()
  code(e, 'CHANCELA_DENIED')
  assert.match(e!.message, /LIMIT_EXCEEDED/)
  assert.equal(g.log.polls, 0)
})

test('REQUIRE_APPROVAL: the plugin names the request, waits, and goes ahead on the owner’s signed ALLOW', async () => {
  const g = await gated({ decision: 'REQUIRE_APPROVAL', approval: [{ status: 'PENDING' }, { status: 'PENDING' }, { status: 'APPROVED', decided: 'ALLOW' }] })
  assert.equal(await g.run(), undefined)
  assert.equal(g.log.polls, 3)
  assert.equal(g.clock.now, T0 + 2 * POLL_MS)
  const said = g.log.said.join('\n')
  assert.match(said, /Approvals → request apr_test/)
  assert.match(said, /Chancela: ALLOW for agent TA-006/)
})

test('REQUIRE_APPROVAL: declined, lapsed, or never decided before the window ends — nothing goes through', async () => {
  code(await (await gated({ decision: 'REQUIRE_APPROVAL', approval: [{ status: 'DENIED' }] })).run(), 'CHANCELA_DECLINED')
  code(await (await gated({ decision: 'REQUIRE_APPROVAL', approval: [{ status: 'DENIED', decided: 'DENY' }] })).run(), 'CHANCELA_DECLINED')
  code(await (await gated({ decision: 'REQUIRE_APPROVAL', approval: [{ status: 'EXPIRED' }] })).run(), 'CHANCELA_APPROVAL_EXPIRED')
  const forever = await gated({ decision: 'REQUIRE_APPROVAL', approval: [{ status: 'PENDING' }] })
  code(await forever.run(), 'CHANCELA_APPROVAL_EXPIRED')
  assert.ok(forever.clock.now >= T0 + 15 * 60_000, 'waited the whole window')
  assert.equal(forever.log.polls, 15 * 60_000 / POLL_MS + 1)
  code(await (await gated({ decision: 'REQUIRE_APPROVAL', approval: ['down'] })).run(), 'CHANCELA_HTTP_503')
})

test('an ALLOW that does not verify — wrong key, another intent, expired, or an approval for other parameters — signs nothing', async () => {
  code(await (await gated({ decision: 'ALLOW', signer: impostorKey })).run(), 'CHANCELA_UNVERIFIED_WRONG_ATTESTOR')
  code(await (await gated({ decision: 'ALLOW', parametersSeen: { ...transferParameters(FEE), amount: 300 } })).run(), 'CHANCELA_UNVERIFIED_INTENT_MISMATCH')
  code(await (await gated({ decision: 'ALLOW', expiresIn: -5 })).run(), 'CHANCELA_UNVERIFIED_EXPIRED')
  code(await (await gated({ decision: 'ALLOW' }, impostorKey.address)).run(), 'CHANCELA_UNVERIFIED_WRONG_ATTESTOR')
  code(await (await gated({ decision: 'REQUIRE_APPROVAL', approval: [{ status: 'APPROVED', decided: 'ALLOW', parametersSeen: { ...transferParameters(FEE), amount: 1 } }] })).run(), 'CHANCELA_UNVERIFIED_INTENT_MISMATCH')
})

test('no answer is never permission: unreachable, a server error, the agent suspended; the server’s text is filtered', async () => {
  const clock = { now: T0 }
  const down = chancelaGate({ agentId: AGENT, baseUrl: 'http://127.0.0.1:9', attestor: attestorKey.address }, { now: () => clock.now, sleep: async () => {}, say: () => {} })
  await assert.rejects(down(FEE), (e: unknown) => e instanceof PluginError && e.code === 'CHANCELA_UNREACHABLE')
  const suspended = await (await gated({ decision: 'ALLOW', error: { status: 403, body: '{"error":{"code":"AGENT_SUSPENDED","message":"too many denials\\nforged line"}}' } })).run()
  code(suspended, 'CHANCELA_AGENT_SUSPENDED')
  assert.ok(!suspended!.message.includes('\n'), suspended!.message)
  code(await (await gated({ decision: 'ALLOW', error: { status: 500, body: 'not json' } })).run(), 'CHANCELA_HTTP_500')
  code(await (await gated({ decision: 'ALLOW', error: { status: 200, body: '{"decision":"ALLOW"}' } })).run(), 'CHANCELA_MALFORMED')
})

// ---- in the flows: after the person's yes, before the wallet signs ---------------------------------

type Routes = Parameters<typeof fakeApi>[0]
const buyRoutes: Routes = { 'GET /config': () => config(), 'GET /me': () => ({ address: wallet.address, active: [], past: [] }), 'POST /enter': (b) => account({ tier: String(b?.tier) }) }
const withGate = (api: ReturnType<typeof fakeApi>['api'], outcome: 'ALLOW' | 'DENY', transfers: Transfer[]) => {
  const made = makeDeps(api, { yes: true })
  made.d.chancela = async (t) => {
    transfers.push(t)
    if (outcome === 'DENY') throw new PluginError('CHANCELA_DENIED', 'refused', 'policy')
  }
  return made
}

test('buy: the fee is described to Chancela after the plan is confirmed; a refusal pays nothing and registers nothing', async () => {
  const transfers: Transfer[] = []
  const refused = fakeApi(buyRoutes)
  await assert.rejects(buy(withGate(refused.api, 'DENY', transfers).d, { size: 5000, pay: 'USDC' }), (e: unknown) => e instanceof PluginError && e.code === 'CHANCELA_DENIED')
  assert.deepEqual([...transfers], [{ amountUsd: 30, recipient: 'MonFunded challenge contract', recipientAddress: CONTRACT, memo: 'fee for plan plan-5000' }])
  assert.ok(!refused.calls.some((c) => c.path === '/enter'), 'no entry registered')
  const allowed = fakeApi(buyRoutes)
  const made = withGate(allowed.api, 'ALLOW', transfers)
  const r = await buy(made.d, { size: 5000, pay: 'USDC' })
  assert.equal(r.done, true)
  assert.equal(made.executor.requests.length, 2, 'approve and enter signed')
  // Shown and refused at the prompt: Chancela is not asked at all.
  const shown = makeDeps(fakeApi(buyRoutes).api)
  const before = transfers.length
  shown.d.chancela = async (t) => {
    transfers.push(t)
  }
  assert.equal((await buy(shown.d, { size: 5000, pay: 'USDC' })).done, false)
  assert.equal(transfers.length, before)
})

test('claim: the payout to this wallet is described to Chancela; a refusal signs nothing', async () => {
  const WID = `0x${'c3'.repeat(32)}` as const
  const unpaid: Withdrawal = { id: WID, amountUsd: 100, paidUsd: 80, token: 'USDC', requestedAt: T0 }
  const accountId = `0x${'a1'.repeat(32)}`
  const proof = { token: 'USDC' as const, logRoot: `0x${'00'.repeat(32)}` as const, signature: `0x${'11'.repeat(65)}` as const }
  const routes: Routes = { 'GET /me': () => ({ address: wallet.address, active: [], past: [account({ id: accountId, status: 'funded', withdrawals: [unpaid] })] }), 'GET /config': () => config(), [`GET /${accountId}/withdrawals/${WID}/claim`]: () => proof }
  const transfers: Transfer[] = []
  const refused = withGate(fakeApi(routes).api, 'DENY', transfers)
  await assert.rejects(claim(refused.d, { withdrawal: WID }), (e: unknown) => e instanceof PluginError && e.code === 'CHANCELA_DENIED')
  assert.equal(refused.executor.requests.length, 0)
  assert.deepEqual([...transfers], [{ amountUsd: 80, recipient: 'this wallet (payout claim)', recipientAddress: wallet.address, memo: `withdrawal ${WID}` }])
  const allowed = withGate(fakeApi(routes).api, 'ALLOW', transfers)
  const r = await claim(allowed.d, { withdrawal: WID })
  assert.equal(r.done, true)
  assert.equal(allowed.executor.requests.length, 1)
})
