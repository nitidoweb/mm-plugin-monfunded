// MetaMask Agent Wallet as the plugin's signer. mm hands a command that holds the wallet-submit
// capability one executor function (ctx.walletExecutor(io, commandId)) for every wallet request,
// and every request goes through Agent Wallet's own policy: Blockaid screening, Guard Mode
// allowlists and 2FA approvals, the 24-hour outflow limit. Its types aren't published, so the
// shapes sent and read are stated here (as @metamask/agent-wallet 6.2's executor takes them).
import { isHex, toHex } from 'viem'
import type { Call, ChainReader } from './chain.ts'
import { CHAIN_ID, EXPLORER_TX, RECEIPT_TIMEOUT_MS } from './constants.ts'
import { PluginError } from './errors.ts'
import type { Address, Hex } from './types.ts'

// The one-line summary MetaMask shows with a request (its "Intent:" line and the 2FA approval).
type Intent = { action: 'custom'; summary: string }

export type ExecutorRequest =
  | { kind: 'message'; chainId: number; message: string; intent: Intent }
  | { kind: 'transaction'; chainId: number; transaction: { to: Address; data: Hex; value: Hex }; intent: Intent }

type ExecutorResult = { kind: string; status: string; signature?: string; hash?: string; failureDescription?: string }

export type Executor = (request: ExecutorRequest, options?: { signal?: AbortSignal; waitForReceipt?: boolean }) => Promise<ExecutorResult>

export interface Signer {
  // personal_sign of `message` by the active wallet.
  signMessage(message: string, summary: string): Promise<Hex>
  // Sends the call, waits until it is mined, and returns its hash. A revert, or a sender other
  // than the signed-in wallet, is an error.
  send(call: Call, summary: string): Promise<Hex>
}

const notDone = (r: ExecutorResult, what: string) =>
  new PluginError('NOT_SIGNED', `MetaMask Agent Wallet did not ${what} (status ${r.status}${r.failureDescription ? `: ${r.failureDescription}` : ''}).`, 'If Guard Mode is waiting for an approval (`mm wallet requests list` shows pending requests), either approve that request or reject it and run the command again. Never both: an approved request is sent, and the command would send it a second time.')

export function executorSigner(exec: Executor, reader: ChainReader, from: Address, signal?: AbortSignal): Signer {
  return {
    async signMessage(message, summary) {
      const r = await exec({ kind: 'message', chainId: CHAIN_ID, message, intent: { action: 'custom', summary } }, { signal })
      if (r.kind !== 'signature' || !isHex(r.signature)) throw notDone(r, 'sign the message')
      return r.signature
    },
    async send(call, summary) {
      const r = await exec({ kind: 'transaction', chainId: CHAIN_ID, transaction: { to: call.to, data: call.data, value: toHex(call.value) }, intent: { action: 'custom', summary } }, { signal, waitForReceipt: true })
      if (r.kind !== 'transaction' || typeof r.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)) throw notDone(r, 'send the transaction')
      const hash = r.hash as Hex
      // Sent: from here on the transaction may land whatever happens to this command, so a missing
      // receipt is its own refusal with the hash, never the reader's raw error.
      const receipt = await reader.receipt(hash).catch(() => {
        throw new PluginError('TX_UNCONFIRMED', `Transaction ${EXPLORER_TX}${hash} was sent, but Monad did not confirm it within ${RECEIPT_TIMEOUT_MS / 1000} s: it may still land.`, 'Don’t send it again. Look the transaction up, and act on what it did once it is confirmed.', hash)
      })
      if (!receipt.success) throw new PluginError('TX_REVERTED', `Transaction ${EXPLORER_TX}${hash} reverted on Monad, so it paid nothing.`, 'Check balances with `mm wallet balance` and the account with `mm monfunded status`, then try again.')
      if (receipt.from.toLowerCase() !== from.toLowerCase()) throw new PluginError('WRONG_SIGNER', `Transaction ${hash} was sent by ${receipt.from}, not the signed-in wallet ${from}.`, 'Use the same wallet in mm and MonFunded: `mm wallet select`, then `mm monfunded login`.')
      return hash
    },
  }
}
