// Between mm and the plugin's flows (src/lib, which never loads mm): builds a flow's dependencies
// from mm's restricted command context (the active wallet, mm's RPC client for Monad, MetaMask's
// signer), shows a plan and asks before anything is signed, and turns the plugin's refusals into
// mm's CommandError (a code, a message and a hint). In a terminal the plan and the summary are
// printed as lines; for agents (--json, or any run without a terminal) they are in the result.
import type { CommandIO, PluginCommandContext } from '@metamask/agent-wallet/plugin'
import { Api } from './lib/api.ts'
import { clientReader } from './lib/chain.ts'
import { API_URL_ENV, CHAIN_ID } from './lib/constants.ts'
import { planLines, type Deps } from './lib/context.ts'
import { PluginError } from './lib/errors.ts'
import { apiTarget } from './lib/inputs.ts'
import { SessionStore, storeDir } from './lib/session.ts'
import { executorSigner, type Executor } from './lib/signer.ts'
import { activeWallet, type WalletState } from './lib/wallet.ts'
import { CommandError } from './sdk.ts'

// Runs a flow for a command: `commandId` is the manifest id MetaMask's executor is asked for, and
// `yes` (the --yes flag) approves the plan without asking.
export async function perform<T extends { summary: string[] }>(ctx: PluginCommandContext, io: CommandIO, commandId: string, flow: (d: Deps) => Promise<T>, yes = false): Promise<T> {
  try {
    // MONFUNDED_DEV=1 is announced on stderr every time (JSON output on stdout stays clean).
    const { base, dev } = apiTarget(process.env, (line) => process.stderr.write(`${line}\n`))
    if (dev && io.isInteractive) io.emit(`Using the MonFunded API at ${base} (${API_URL_ENV}, developer mode).`)
    const wallet = activeWallet(ctx.walletStateManager.read() as WalletState)
    const reader = clientReader(ctx.publicClient(CHAIN_ID))
    const deps: Deps = {
      api: new Api(base, fetch, io.signal, { dev }),
      store: new SessionStore(storeDir(process.env)),
      wallet,
      reader,
      kuru: fetch,
      signer: async () => executorSigner((await ctx.walletExecutor(io, commandId)) as Executor, reader, wallet, io.signal),
      confirm: async (plan) => {
        if (io.isInteractive) for (const line of planLines(plan)) io.emit(line)
        if (yes) return true
        return io.isInteractive ? io.ask({ kind: 'confirm', message: 'Go ahead? Your MetaMask Agent Wallet signs and sends it.' }) : false
      },
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
    const result = await flow(deps)
    if (io.isInteractive) for (const line of result.summary) io.emit(line)
    return result
  } catch (e) {
    if (e instanceof PluginError) throw new CommandError(e.code, e.message, e.hint)
    throw e
  }
}
