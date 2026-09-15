// mm's active EVM wallet, from its wallet state (ctx.walletStateManager.read(): the server and BYOK
// wallets, and the selection `mm wallet select` made).
import { PluginError } from './errors.ts'
import type { Address } from './types.ts'

type WalletRef = { id?: string; address?: string; name?: string }
type WalletEntry = WalletRef & { namespace?: string }
export type WalletState = { byokWallets?: WalletEntry[]; remoteWallets?: WalletEntry[]; selectedWallet?: { namespace?: string; ref?: WalletRef } }

const isEvm = (w: { namespace?: string }) => (w.namespace ?? 'evm') === 'evm'

// The selected EVM wallet, else the only one. Several without a selection is refused rather than
// guessed, so the plugin never signs in as one wallet while mm signs with another.
export function activeWallet(state: WalletState): Address {
  const wallets = [...(state.remoteWallets ?? []), ...(state.byokWallets ?? [])].filter((w) => isEvm(w) && /^0x[0-9a-fA-F]{40}$/.test(w.address ?? ''))
  const sel = state.selectedWallet
  const ref = sel && isEvm(sel) ? sel.ref : undefined
  const chosen = ref
    ? wallets.find((w) => (ref.id !== undefined && w.id === ref.id) || (ref.address !== undefined && w.address?.toLowerCase() === ref.address.toLowerCase()) || (ref.name !== undefined && w.name === ref.name))
    : wallets.length === 1
      ? wallets[0]
      : undefined
  if (!chosen?.address) {
    if (!wallets.length) throw new PluginError('NO_WALLET', 'MetaMask Agent Wallet has no EVM wallet yet.', 'Run `mm init` to create or import one.')
    throw new PluginError('NO_WALLET', ref ? 'The wallet selected in MetaMask Agent Wallet is not in its wallet list.' : 'MetaMask Agent Wallet has several EVM wallets and none is selected.', 'Pick one with `mm wallet select <address>` (see `mm wallet list`).')
  }
  return chosen.address as Address
}
