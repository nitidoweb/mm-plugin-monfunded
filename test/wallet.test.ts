// Which wallet the plugin acts as: mm's selection, else its only EVM wallet, never a guess.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PluginError } from '../src/lib/errors.ts'
import { activeWallet } from '../src/lib/wallet.ts'

const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'

test('the selected wallet, by id, address or name', () => {
  const state = { remoteWallets: [{ id: 'w1', address: A }], byokWallets: [{ address: B, name: 'mine' }] }
  assert.equal(activeWallet({ ...state, selectedWallet: { namespace: 'evm', ref: { id: 'w1' } } }), A)
  assert.equal(activeWallet({ ...state, selectedWallet: { namespace: 'evm', ref: { address: B.toUpperCase().replace('0X', '0x') } } }), B)
  assert.equal(activeWallet({ ...state, selectedWallet: { ref: { name: 'mine' } } }), B)
})

test('the only EVM wallet when nothing is selected; other chains’ wallets are ignored', () => {
  assert.equal(activeWallet({ remoteWallets: [{ address: A }, { address: 'So1ana', namespace: 'solana' }] }), A)
})

test('several wallets and no selection, a stale selection, or none at all are refused', () => {
  const refused = (state: Parameters<typeof activeWallet>[0]) => assert.throws(() => activeWallet(state), (e) => e instanceof PluginError && e.code === 'NO_WALLET')
  refused({ remoteWallets: [{ address: A }], byokWallets: [{ address: B }] })
  refused({ remoteWallets: [{ address: A }], selectedWallet: { ref: { id: 'gone' } } })
  refused({})
})
