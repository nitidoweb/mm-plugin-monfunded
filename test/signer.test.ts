// MetaMask's executor as the plugin's signer: the requests it gets, and the outcomes it refuses.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoverMessageAddress } from 'viem'
import { approveCall } from '../src/lib/chain.ts'
import { USDC } from '../src/lib/constants.ts'
import { PluginError } from '../src/lib/errors.ts'
import { executorSigner, type Executor } from '../src/lib/signer.ts'
import { CONTRACT, fakeChain, fakeExecutor, wallet } from './fakes.ts'

const code = (c: string) => (e: unknown) => e instanceof PluginError && e.code === c

test('a message is a personal_sign request on Monad with a summary for MetaMask', async () => {
  const { exec, requests } = fakeExecutor()
  const signer = executorSigner(exec, fakeChain().reader, wallet.address)
  const signature = await signer.signMessage('hello', 'Sign in to MonFunded')
  assert.deepEqual(requests, [{ kind: 'message', chainId: 143, message: 'hello', intent: { action: 'custom', summary: 'Sign in to MonFunded' } }])
  assert.equal(await recoverMessageAddress({ message: 'hello', signature }), wallet.address)
})

test('a transaction is sent on Monad, waited for, and its hash returned', async () => {
  const { exec, requests } = fakeExecutor()
  const call = approveCall(USDC, CONTRACT, 30_000_000n)
  const hash = await executorSigner(exec, fakeChain().reader, wallet.address).send(call, 'approve')
  assert.match(hash, /^0x[0-9a-f]{64}$/)
  assert.deepEqual(requests, [{ kind: 'transaction', chainId: 143, transaction: { to: USDC, data: call.data, value: '0x0' }, intent: { action: 'custom', summary: 'approve' } }])
})

test('a reverted transaction, a stranger as sender, or no hash are refusals', async () => {
  const chain = fakeChain()
  const { exec } = fakeExecutor()
  const call = approveCall(USDC, CONTRACT, 1n)
  const reverted: Executor = async (r) => {
    const out = await exec(r)
    chain.receipts.set(out.hash as string, { from: wallet.address, success: false })
    return out
  }
  await assert.rejects(executorSigner(reverted, chain.reader, wallet.address).send(call, 'x'), code('TX_REVERTED'))
  const stranger: Executor = async (r) => {
    const out = await exec(r)
    chain.receipts.set(out.hash as string, { from: CONTRACT, success: true })
    return out
  }
  await assert.rejects(executorSigner(stranger, chain.reader, wallet.address).send(call, 'x'), code('WRONG_SIGNER'))
  // Sent, but no receipt in time: it may still land, and the refusal carries its hash.
  const lost = fakeChain()
  lost.reader.receipt = async () => {
    throw new Error('Timed out while waiting for transaction')
  }
  await assert.rejects(executorSigner(exec, lost.reader, wallet.address).send(call, 'x'), (e) => code('TX_UNCONFIRMED')(e) && /^0x[0-9a-f]{64}$/.test((e as PluginError).tx ?? '') && (e as Error).message.includes((e as PluginError).tx ?? 'none') && !/Timed out/.test((e as Error).message))
  const pending: Executor = async () => ({ kind: 'transaction', status: 'AWAITING_MFA' })
  await assert.rejects(executorSigner(pending, chain.reader, wallet.address).send(call, 'x'), (e) => code('NOT_SIGNED')(e) && /AWAITING_MFA/.test((e as Error).message))
  const unsigned: Executor = async () => ({ kind: 'signature', status: 'DENIED', failureDescription: 'denied by policy' })
  await assert.rejects(executorSigner(unsigned, chain.reader, wallet.address).signMessage('x', 'x'), (e) => code('NOT_SIGNED')(e) && /denied by policy/.test((e as Error).message))
})
