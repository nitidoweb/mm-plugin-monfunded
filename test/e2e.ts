// The whole flow end to end, with nothing real: `npm run test:e2e` in agent/ (after `npm install`
// at the repository root and in agent/). It is also the demo: it prints every step as the terminal
// session it stands for.
//
// - Monad: the compiled MonFundedChallenge (contracts/out) in an in-memory EVM (chain id 143), with
//   test coins at Monad's USDC and AUSD addresses, served over JSON-RPC to the server and the plugin.
// - MonFunded: server/challenge.mjs on http://127.0.0.1:4417 (CHALLENGE_TEST=1, Perpl prices from a
//   stub file this script moves, a throwaway operator key); `npm run test:e2e -- --serve` runs the
//   production server/serve.mjs instead (after `npm run build` at the root). The plugin reaches it
//   the way a developer would: MONFUNDED_DEV=1 with MONFUNDED_API_URL, so the server's own contract
//   is trusted (the release pins monfunded.com's) and the developer-mode warning prints first.
// - MetaMask: a stand-in executor that signs with a throwaway key and runs each transaction in the
//   EVM, behind the plugin's own signer (the one mm's real executor sits behind).
// The plugin's flows (src/lib) do the rest, and the chain is checked after every payment.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createCustomCommon, Mainnet } from '@ethereumjs/common'
import { createEVM } from '@ethereumjs/evm'
import { bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util'
import { createPublicClient, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, toHex, type AbiParameter, type Address, type Hex, type TransactionSerialized } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Api, type Fetch } from '../src/lib/api.ts'
import { buy } from '../src/lib/buy.ts'
import { CHALLENGE_ABI, clientReader } from '../src/lib/chain.ts'
import { API_URL_ENV, AUSD, DEV_ENV, USDC } from '../src/lib/constants.ts'
import { planLines, type Deps, type Plan } from '../src/lib/context.ts'
import { PluginError } from '../src/lib/errors.ts'
import { apiTarget } from '../src/lib/inputs.ts'
import { login } from '../src/lib/login.ts'
import { claim, withdraw } from '../src/lib/payout.ts'
import { SessionStore } from '../src/lib/session.ts'
import { executorSigner, type Executor } from '../src/lib/signer.ts'
import { status } from '../src/lib/status.ts'
import { close, coach, order } from '../src/lib/trade.ts'
// @ts-expect-error The repository's test cluster helper is plain JavaScript, with no types.
import { startTestCluster } from '../../scripts/lib/pg-test.mjs'

const ROOT = new URL('../../', import.meta.url)
const PORT = 4417
const SERVE = process.argv.includes('--serve')
const require = createRequire(import.meta.url)
const solc = require('solc') as { compile(input: string): string }

// ---- Monad: the contract, two test coins and a router stand-in in an in-memory EVM ----

const artifact = JSON.parse(readFileSync(new URL('contracts/out/MonFundedChallenge.json', ROOT), 'utf8')) as { abi: { type: string; inputs?: AbiParameter[] }[]; bytecode: string }
const TIERS = JSON.parse(readFileSync(new URL('server/tiers.json', ROOT), 'utf8')) as { index: number; feeUsd: number }[]

const MOCKS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TestCoin {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { return move(msg.sender, to, amount); }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        return move(from, to, amount);
    }
    function move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// The contract needs a router with code; fees in MON aren't part of this test.
contract NoRouter {
    fallback() external payable { revert("no MON fees in this test"); }
}
`
type Compiled = { abi: { type: string; inputs?: AbiParameter[] }[]; evm: { bytecode: { object: string } } }
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Mocks.sol': { content: MOCKS } }, settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })))
const { TestCoin, NoRouter } = compiled.contracts['Mocks.sol'] as Record<'TestCoin' | 'NoRouter', Compiled>
const COIN_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address account) view returns (uint256)'])

const evm = await createEVM({ common: createCustomCommon({ chainId: 143 }, Mainnet) })
// One EVM operation at a time: the server and the plugin read and send concurrently.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

type Log = { address: Address; topics: Hex[]; data: Hex }
async function run(from: Address, to: Address | undefined, data: Hex, value = 0n) {
  const r = await evm.runCall({ caller: createAddressFromString(from), ...(to && { to: createAddressFromString(to) }), data: hexToBytes(data), value, gasLimit: 10_000_000n, skipBalance: true })
  const logs: Log[] = (r.execResult.logs ?? []).map(([a, topics, d]) => ({ address: getAddress(bytesToHex(a)), topics: topics.map((t) => bytesToHex(t)), data: bytesToHex(d) }))
  return { ok: !r.execResult.exceptionError, ret: bytesToHex(r.execResult.returnValue), logs, created: r.createdAddress ? getAddress(r.createdAddress.toString()) : undefined }
}

// A view, run and rolled back.
const view = (to: Address, data: Hex) =>
  serial(async () => {
    await evm.stateManager.checkpoint()
    try {
      return await run(getAddress('0x0000000000000000000000000000000000000000'), to, data)
    } finally {
      await evm.stateManager.revert()
    }
  })

// Mined transactions: their receipts, as eth_getTransactionReceipt answers them.
const receipts = new Map<string, Record<string, unknown>>()
let block = 16n
async function mine(from: Address, to: Address, data: Hex, value: bigint, hash: Hex) {
  const r = await run(from, to, data, value)
  block++
  const blockHash = keccak256(toHex(`block ${block}`))
  receipts.set(hash, {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash,
    blockNumber: toHex(block),
    from,
    to,
    status: r.ok ? '0x1' : '0x0',
    type: '0x2',
    gasUsed: '0x30d40',
    cumulativeGasUsed: '0x30d40',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logsBloom: `0x${'00'.repeat(256)}`,
    logs: r.logs.map((l, i) => ({ ...l, logIndex: toHex(i), transactionIndex: '0x0', transactionHash: hash, blockHash, blockNumber: toHex(block), removed: false })),
  })
  return r.ok
}

const deployer = getAddress('0x0000000000000000000000000000000000000a01')
async function deploy(c: { abi: { type: string; inputs?: AbiParameter[] }[]; bytecode: string }, args: unknown[] = []) {
  const ctor = c.abi.find((x) => x.type === 'constructor')
  const data = `0x${c.bytecode.replace(/^0x/, '')}${ctor?.inputs ? encodeAbiParameters(ctor.inputs, args).slice(2) : ''}` as Hex
  const r = await serial(() => run(deployer, undefined, data))
  assert.ok(r.ok && r.created, 'a deployment failed')
  return r.created
}

const trader = privateKeyToAccount(generatePrivateKey())
const operatorKey = generatePrivateKey()
const operator = privateKeyToAccount(operatorKey)
// The MonFunded team's own address (server/challenge-api.md, "Payouts"): a first payout always
// meets a person, and the plugin itself has no admin commands, so this test signs in and releases
// it directly against the API, the way the team's own console would.
const admin = privateKeyToAccount(generatePrivateKey())

// The coins: the test coin's code at Monad's own USDC and AUSD addresses, as the server expects.
const scratch = await deploy({ abi: TestCoin.abi, bytecode: TestCoin.evm.bytecode.object })
const coinCode = await evm.stateManager.getCode(createAddressFromString(scratch))
for (const coin of [USDC, AUSD]) await evm.stateManager.putCode(createAddressFromString(coin), coinCode)
const router = await deploy({ abi: NoRouter.abi, bytecode: NoRouter.evm.bytecode.object })
const fees = Array.from({ length: Math.max(...TIERS.map((t) => t.index)) + 1 }, (_, i) => BigInt(Math.round((TIERS.find((t) => t.index === i)?.feeUsd ?? 0) * 1e6)))
const contract = await deploy(artifact, [USDC, AUSD, operator.address, router, fees])

const mint = (coin: Address, to: Address, units: bigint) => serial(() => run(deployer, coin, encodeFunctionData({ abi: COIN_ABI, functionName: 'mint', args: [to, units] })))
const balanceOf = async (coin: Address, who: Address) => decodeFunctionResult({ abi: COIN_ABI, functionName: 'balanceOf', data: (await view(coin, encodeFunctionData({ abi: COIN_ABI, functionName: 'balanceOf', args: [who] }))).ret })
const isPaid = async (wid: Hex) => decodeFunctionResult({ abi: CHALLENGE_ABI, functionName: 'paid', data: (await view(contract, encodeFunctionData({ abi: CHALLENGE_ABI, functionName: 'paid', args: [wid] }))).ret })
// The trader's 1,000 USDC; the payout reserves: 500 USDC and 500 AUSD in the contract.
await mint(USDC, trader.address, 1_000_000_000n)
await mint(USDC, contract, 500_000_000n)
await mint(AUSD, contract, 500_000_000n)

// ---- Monad's JSON-RPC, for the server (entries, reserves, the operator's payouts) and the plugin ----

// The operator's payout transactions are refused throughout this run (as when its wallet has no
// MON for gas), so the trader claims its payout from the contract instead.
const payoutsOn = false
// The server's clock, moved by the script (CHALLENGE_TEST honours x-challenge-now): the 60 s hold
// passes without waiting a minute, and days pass in a moment. The chain's blocks carry the same
// time, so an entry paid on a later day is as fresh to the server as it is on Monad.
const clock = { now: Date.now() }
const nonces = new Map<string, number>()
const rpcServer = createServer((req, res) => {
  let text = ''
  req.on('data', (c) => (text += c))
  req.on('end', async () => {
    const { id, method, params } = JSON.parse(text)
    const reply = (body: object) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...body }))
    }
    const answer = (result: unknown) => reply({ result })
    const refuse = (message: string, data?: Hex) => reply({ error: { code: data ? 3 : -32601, message, ...(data && { data }) } })
    try {
      switch (method) {
        case 'eth_chainId':
          return answer('0x8f')
        case 'eth_blockNumber':
          return answer(toHex(block))
        case 'eth_getBalance':
          return answer(toHex(100n * 10n ** 18n))
        case 'eth_call': {
          const r = await view(params[0].to, params[0].data ?? params[0].input ?? '0x')
          return r.ok ? answer(r.ret) : refuse('execution reverted', r.ret)
        }
        case 'eth_getTransactionReceipt':
          return answer(receipts.get(params[0]) ?? null)
        case 'eth_getTransactionCount':
          return answer(toHex(nonces.get(String(params[0]).toLowerCase()) ?? 0))
        case 'eth_estimateGas':
          return answer('0x30d40')
        case 'eth_maxPriorityFeePerGas':
          return answer('0x1')
        case 'eth_gasPrice':
          return answer('0x2')
        case 'eth_getBlockByNumber':
          return answer({ number: toHex(block), hash: keccak256(toHex(`block ${block}`)), parentHash: `0x${'00'.repeat(32)}`, baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: toHex(Math.floor(clock.now / 1000)), transactions: [], miner: deployer, nonce: '0x0000000000000000', difficulty: '0x0', extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`, size: '0x0', sha3Uncles: `0x${'00'.repeat(32)}`, stateRoot: `0x${'00'.repeat(32)}`, transactionsRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`, uncles: [] })
        case 'eth_sendRawTransaction': {
          if (!payoutsOn) return refuse('test: the operator’s payouts are paused')
          const raw = params[0] as TransactionSerialized
          const tx = parseTransaction(raw)
          const from = await recoverTransactionAddress({ serializedTransaction: raw })
          nonces.set(from.toLowerCase(), (nonces.get(from.toLowerCase()) ?? 0) + 1)
          const hash = keccak256(raw)
          await serial(() => mine(from, tx.to as Address, tx.data ?? '0x', tx.value ?? 0n, hash))
          return answer(hash)
        }
        default:
          return refuse(`test: ${method} is not served`)
      }
    } catch (e) {
      refuse(e instanceof Error ? e.message : String(e))
    }
  })
})
await new Promise<void>((resolve) => rpcServer.listen(0, '127.0.0.1', resolve))
const RPC = `http://127.0.0.1:${(rpcServer.address() as { port: number }).port}`

// ---- MetaMask: a stand-in executor that signs with the trader's key and mines in the EVM ----

let sent = 0
const executor: Executor = async (request) => {
  if (request.kind === 'message') return { kind: 'signature', status: 'CONFIRMED', signature: await trader.signMessage({ message: request.message }) }
  const hash = keccak256(toHex(`trader transaction ${++sent}`))
  await serial(() => mine(trader.address, request.transaction.to, request.transaction.data, BigInt(request.transaction.value), hash))
  return { kind: 'transaction', status: 'CONFIRMED', hash }
}
const reader = clientReader(createPublicClient({ transport: http(RPC), pollingInterval: 50 }))

// ---- MonFunded: the server on :4417, prices from a stub file ----

const state = mkdtempSync(join(tmpdir(), 'monfunded-agent-e2e-'))
// The journal (and the stores) in a throwaway PostgreSQL cluster of its own.
const cluster = await startTestCluster()
const db = await cluster.createDb()
const stub = join(state, 'prices.json')
const setBtc = (price: number) => writeFileSync(stub, JSON.stringify({ 'perpl:BTC': { price, bid: price - 0.5, ask: price + 0.5, maxLeverage: 15 } }))
setBtc(60_000)
const HARNESS = `
import { createServer } from 'node:http'
import { handleChallenge } from ${JSON.stringify(new URL('server/challenge.mjs', ROOT).pathname)}
createServer((req, res) => {
  handleChallenge(req, res, new URL(req.url, 'http://localhost')).then((handled) => {
    if (!handled) res.writeHead(404).end()
  })
}).listen(${PORT}, '127.0.0.1')
`
// The caller's own integration and admin settings never reach the server under test.
const { NANSEN_API_KEY: _n, AURORA_API_KEY: _a, ENVIO_GRAPHQL_URL: _e, CHALLENGE_OPERATOR_KEY: _o, CREDENTIALS_DIRECTORY: _c, CHALLENGE_ADMINS: _ad, ...env } = process.env
const server = spawn(process.execPath, SERVE ? ['server/serve.mjs'] : ['--input-type=module', '-e', HARNESS], {
  cwd: ROOT,
  env: { ...env, PORT: String(PORT), HOST: '127.0.0.1', MONFUNDED_STATE: state, ...db.env, CHALLENGE_TEST: '1', CHALLENGE_PRICES_STUB: stub, CHALLENGE_RPC: RPC, CHALLENGE_CONTRACT: contract, CHALLENGE_OPERATOR_KEY: operatorKey, CHALLENGE_ADMINS: admin.address },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d))
server.stderr.on('data', (d) => (serverLog += d))

// As a developer points the plugin at a local server (mm prints the warning on stderr).
const { base: BASE, dev } = apiTarget({ [DEV_ENV]: '1', [API_URL_ENV]: `http://127.0.0.1:${PORT}` }, (line) => console.log(line))
assert.equal(dev, true)
// Ready once it answers with the contract and has read both reserves.
for (let i = 0; ; i++) {
  const config = await fetch(`${BASE}/challenge/config`)
    .then((r) => (r.ok ? (r.json() as Promise<{ contract: string | null; reserves: Record<string, number | null> }>) : undefined))
    .catch(() => undefined)
  if (config?.contract && config.reserves?.USDC !== null && config.reserves?.AUSD !== null) break
  if (i > 100 || server.exitCode !== null) throw new Error(`the MonFunded server did not start on :${PORT}\n${serverLog}`)
  await delay(200)
}

// ---- the plugin: its flows, run the way each mm command runs them ----

const apiFetch: Fetch = (url, init) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'x-challenge-now': String(clock.now) } })
const store = new SessionStore(join(state, 'agent'))
let approve = false
// A fresh API client per command, as each mm run has: the session comes from the session file.
const deps = (): Deps => ({
  api: new Api(BASE, apiFetch, undefined, { dev }),
  store,
  wallet: trader.address,
  reader,
  kuru: async () => {
    throw new Error('no MON fees in this test')
  },
  signer: async () => executorSigner(executor, reader, trader.address),
  confirm: async () => approve,
  now: () => clock.now,
  sleep: async (ms) => {
    clock.now += ms
    await delay(Math.min(ms, 200))
  },
})

// The MonFunded team's own release: signs in as `admin` (the plugin has no commands for this) and
// approves the held withdrawal directly against the API, the way the team's own console would.
async function releaseAsAdmin(withdrawalId: Hex) {
  const adminApi = new Api(BASE, apiFetch, undefined, { dev })
  const { nonce, message } = await adminApi.nonce(admin.address)
  const signature = await admin.signMessage({ message })
  const { cookie } = await adminApi.verify(admin.address, nonce, signature)
  const res = await apiFetch(`${BASE}/challenge/admin/payouts/${withdrawalId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `__Host-monfunded_session=${cookie}` }, body: '{}' })
  assert.equal(res.status, 200, `admin release of ${withdrawalId} failed: ${await res.text()}`)
}

function show(command: string, result: { summary: string[]; plan?: Plan; done?: boolean }) {
  console.log(`\n$ mm monfunded ${command}`)
  if (result.plan && result.done === false) for (const line of planLines(result.plan)) console.log(`  ${line}`)
  for (const line of result.summary) console.log(`  ${line}`)
}
async function refused(command: string, attempt: Promise<unknown>, code: string) {
  console.log(`\n$ mm monfunded ${command}`)
  try {
    await attempt
  } catch (e) {
    assert.ok(e instanceof PluginError, String(e))
    assert.equal(e.code, code)
    console.log(`  Refused (${e.code}): ${e.message}`)
    return
  }
  assert.fail(`${command} should have been refused with ${code}`)
}
const note = (text: string) => console.log(`\n# ${text}`)
const usdc = (units: bigint) => Number(units) / 1e6

try {
  console.log(`MonFunded agent plugin, end to end: in-memory Monad (contract ${contract}), MonFunded server on ${BASE}${SERVE ? ' (server/serve.mjs)' : ''}, MetaMask stand-in for ${trader.address}.`)

  const before = await status(deps())
  show('status', before)
  assert.equal(before.signedIn, false)
  assert.equal(before.entriesOpen, true)

  const signedIn = await login(deps())
  show('login', signedIn)
  assert.equal(signedIn.wallet, trader.address)

  const preview = await buy(deps(), { size: 10_000, pay: 'USDC' })
  show('buy --size 10k --pay usdc', preview)
  assert.equal(preview.done, false)
  assert.equal(await balanceOf(USDC, trader.address), 1_000_000_000n, 'a preview pays nothing')

  approve = true
  const bought = await buy(deps(), { size: 10_000, pay: 'USDC' })
  show('buy --size 10k --pay usdc --yes', bought)
  assert.ok(bought.done && 'account' in bought)
  assert.equal(await balanceOf(USDC, trader.address), 911_000_000n, 'the trader paid the $89 fee')
  assert.equal(await balanceOf(USDC, contract), 589_000_000n, 'the fee is in the USDC reserve')
  note(`Chain: the trader holds ${usdc(await balanceOf(USDC, trader.address))} USDC; the contract’s USDC reserve holds ${usdc(await balanceOf(USDC, contract))}.`)

  const BTC = { market: 'perpl:BTC', side: 'long' } as const
  const caution = await coach(deps(), { ...BTC, notional: 40_000, leverage: 5 })
  show('coach --market BTC --side long --notional 40000 --leverage 5', caution)
  assert.equal(caution.verdict, 'caution')
  const blocked = await coach(deps(), { ...BTC, notional: 5000, leverage: 16 })
  show('coach --market BTC --side long --notional 5000 --leverage 16', blocked)
  assert.equal(blocked.verdict, 'blocked')
  const fine = await coach(deps(), { ...BTC, notional: 5000, leverage: 2 })
  show('coach --market BTC --side long --notional 5000 --leverage 2', fine)
  assert.equal(fine.verdict, 'ok')

  const first = await order(deps(), { ...BTC, notional: 5000, leverage: 2 })
  show('order --market BTC --side long --notional 5000 --leverage 2', first)
  assert.equal(first.position.status, 'open')
  assert.equal(first.position.entryPrice, 60_000.5)
  await refused(`close --position ${first.position.id}`, close(deps(), { position: first.position.id }), 'HOLD_TIME')
  await refused('order --market BTC --side short --notional 5000 --leverage 2', order(deps(), { ...BTC, side: 'short', notional: 5000, leverage: 2 }), 'HEDGING')

  // The 10 % target is $1,000, and no day may be worth more than 30 % of the profit at the pass:
  // four days of about $275 each. After the first, that day is all of the profit, so status says the
  // pass would wait.
  let passed: Awaited<ReturnType<typeof close>> | undefined
  let live = first
  for (let day = 1; day <= 4; day++) {
    note(`Day ${day}: BTC rises to 63,300 and a minute passes.`)
    setBtc(63_300)
    clock.now += 61_000
    passed = await close(deps(), { position: live.position.id })
    show(`close --position ${live.position.id}`, passed)
    if (day === 1) {
      const one = await status(deps())
      assert.ok(one.signedIn && 'accounts' in one)
      assert.equal(one.accounts[0].consistency?.ok, false, 'one day is all of the profit so far')
      assert.equal(one.accounts[0].consistency?.limitPct, 30)
    }
    if (day === 4) break
    assert.equal(passed.passed, false)
    note('The next day, BTC back at 60,000.')
    setBtc(60_000)
    clock.now += 86_400_000
    live = await order(deps(), { ...BTC, notional: 5000, leverage: 2 })
    show('order --market BTC --side long --notional 5000 --leverage 2', live)
    assert.equal(live.position.status, 'open')
  }
  assert.equal(passed?.passed, true)
  assert.equal(passed?.accountStatus, 'funded')
  setBtc(60_000)
  clock.now += 86_400_000

  const second = await order(deps(), { ...BTC, notional: 5000, leverage: 2 })
  show('order --market BTC --side long --notional 5000 --leverage 2', second)
  assert.equal(second.position.status, 'open')
  note('BTC rises to 66,000 and a minute passes.')
  setBtc(66_000)
  clock.now += 61_000
  const profit = await close(deps(), { position: second.position.id })
  show(`close --position ${second.position.id}`, profit)
  assert.ok((profit.position.pnlUsd ?? 0) > 400)

  const funded = await status(deps())
  show('status', funded)
  assert.ok(funded.signedIn && 'accounts' in funded)
  assert.ok((funded.accounts[0].withdrawable?.amountUsd ?? 0) > 400)

  const receiveUsd = funded.accounts[0].withdrawable?.youReceiveUsd ?? 0
  note('A payout takes the whole profit at once. This one waits for a person at MonFunded, who releases it before it can pay or be claimed; the operator’s payouts are paused meanwhile (as when its wallet runs out of MON), so this one is claimed.')
  const w1 = await withdraw(deps(), { token: 'AUSD' })
  show('withdraw --token ausd --yes', w1)
  assert.ok(w1.done && 'withdrawal' in w1)
  assert.equal(w1.withdrawal.state, 'review')
  const wid = w1.withdrawal.id as Hex
  await releaseAsAdmin(wid)
  const claimed = await claim(deps(), { withdrawal: wid })
  show(`claim --withdrawal ${wid} --yes`, claimed)
  assert.ok(claimed.done && !claimed.alreadyPaid)
  assert.equal(await balanceOf(AUSD, trader.address), BigInt(Math.round(receiveUsd * 1e6)), 'the trader received 80 % of the whole profit in AUSD')
  assert.equal(await isPaid(wid), true, 'the contract pays each withdrawal once')
  note(`Chain: the trader holds ${usdc(await balanceOf(AUSD, trader.address))} AUSD; the contract marks ${wid.slice(0, 10)}… paid. The account stays paused until it trades again from its starting balance.`)

  // The server takes five assessments at a time from one wallet, and the plugin's own check is the
  // same five: all five register, and the sixth is refused before anything is signed.
  note('One wallet runs five assessments at a time: it buys five more, one after the other, and the sixth is refused before anything is paid.')
  for (let n = 1; n <= 5; n++) {
    clock.now += 61_000
    const more = await buy(deps(), { size: 10_000, pay: 'USDC' })
    assert.ok(more.done && 'account' in more, `assessment ${n} of 5 registered`)
  }
  assert.equal(await balanceOf(USDC, trader.address), 466_000_000n, 'five more $89 fees')
  clock.now += 61_000
  await refused('buy --size 10k --pay usdc --yes', buy(deps(), { size: 10_000, pay: 'USDC' }), 'TOO_MANY_ASSESSMENTS')
  assert.equal(await balanceOf(USDC, trader.address), 466_000_000n, 'a refused buy pays nothing')

  console.log('\nEnd to end: every step and every on-chain check passed.')
} catch (e) {
  console.error(`\nFAILED: ${e instanceof Error ? (e.stack ?? e.message) : e}\n\n--- server log ---\n${serverLog}`)
  process.exitCode = 1
} finally {
  server.kill()
  await cluster.stop()
  rpcServer.close()
  rmSync(state, { recursive: true, force: true })
}
