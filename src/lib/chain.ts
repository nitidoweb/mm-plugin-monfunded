// The MonFundedChallenge contract (contracts/MonFundedChallenge.sol, v3) and the two coins on
// Monad: the calls the plugin sends through MetaMask, and the reads it makes first (through mm's
// own authenticated RPC client) so nothing is signed that would revert or pay the wrong amount.
import { encodeFunctionData, getAddress, parseAbi, type PublicClient } from 'viem'
import { RECEIPT_TIMEOUT_MS } from './constants.ts'
import type { Address, Hex, PayoutToken } from './types.ts'

export const CHALLENGE_ABI = parseAbi([
  'function enter(uint8 tier)',
  'function enterWithAusd(uint8 tier)',
  'function enterWithMon(uint8 tier, address market, uint256 minUsdcOut) payable',
  'function claim(bytes32 withdrawalId, address token, uint256 amount, bytes32 logRoot, bytes signature)',
  'function tiers(uint8 tier) view returns (uint256)',
  'function paid(bytes32 withdrawalId) view returns (bool)',
  'function usdc() view returns (address)',
  'function ausd() view returns (address)',
])

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
])

// USD in the coins' 6-decimal units (USDC and AUSD alike), the same rounding as the server's
// usd6, so a claim's amount matches the operator's signature to the unit.
export const usd6 = (usd: number) => BigInt(Math.round(usd * 1_000_000))

// One transaction for MetaMask to sign and send.
export type Call = { to: Address; data: Hex; value: bigint }

// approve(spender, amount): exactly the fee, never an open-ended allowance.
export const approveCall = (token: Address, spender: Address, amount: bigint): Call => ({ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }), value: 0n })

// enter(index) pays the plan's fee in USDC, enterWithAusd(index) the same fee in AUSD.
export const enterCall = (contract: Address, index: number, coin: PayoutToken): Call => ({ to: contract, data: encodeFunctionData({ abi: CHALLENGE_ABI, functionName: coin === 'AUSD' ? 'enterWithAusd' : 'enter', args: [index] }), value: 0n })

// enterWithMon(index, market, fee): `monWei` is sold for USDC on Kuru's MON_USDC book inside the
// contract; the fee is the router's own floor, so a moved book reverts instead of underpaying.
export const enterWithMonCall = (contract: Address, index: number, market: Address, minUsdcOut: bigint, monWei: bigint): Call => ({ to: contract, data: encodeFunctionData({ abi: CHALLENGE_ABI, functionName: 'enterWithMon', args: [index, market, minUsdcOut] }), value: monWei })

// claim(withdrawalId, token, amount, logRoot, signature): pays msg.sender, so only the trader's own
// wallet can use the operator's signature.
export const claimCall = (contract: Address, withdrawalId: Hex, token: Address, amount: bigint, logRoot: Hex, signature: Hex): Call => ({
  to: contract,
  data: encodeFunctionData({ abi: CHALLENGE_ABI, functionName: 'claim', args: [withdrawalId, token, amount, logRoot, signature] }),
  value: 0n,
})

// The chain reads the flows need, so tests can stand in for Monad.
export interface ChainReader {
  tokenBalance(token: Address, owner: Address): Promise<bigint>
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>
  nativeBalance(owner: Address): Promise<bigint>
  // What the contract charges for a plan's index (6 decimals; 0 = closed).
  tierFee(contract: Address, index: number): Promise<bigint>
  // The two coins the contract pays and takes.
  coins(contract: Address): Promise<{ usdc: Address; ausd: Address }>
  isPaid(contract: Address, withdrawalId: Hex): Promise<boolean>
  // Waits for a transaction to be mined: who sent it and whether it succeeded.
  receipt(hash: Hex): Promise<{ from: Address; success: boolean }>
}

// The reads over a viem public client: mm's ctx.publicClient(143), or any client for tests.
export function clientReader(client: PublicClient): ChainReader {
  return {
    tokenBalance: (token, owner) => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }),
    allowance: (token, owner, spender) => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] }),
    nativeBalance: (owner) => client.getBalance({ address: owner }),
    tierFee: (contract, index) => client.readContract({ address: contract, abi: CHALLENGE_ABI, functionName: 'tiers', args: [index] }),
    coins: async (contract) => {
      const [usdc, ausd] = await Promise.all([client.readContract({ address: contract, abi: CHALLENGE_ABI, functionName: 'usdc' }), client.readContract({ address: contract, abi: CHALLENGE_ABI, functionName: 'ausd' })])
      return { usdc: getAddress(usdc), ausd: getAddress(ausd) }
    },
    isPaid: (contract, withdrawalId) => client.readContract({ address: contract, abi: CHALLENGE_ABI, functionName: 'paid', args: [withdrawalId] }),
    receipt: async (hash) => {
      const r = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
      return { from: getAddress(r.from), success: r.status === 'success' }
    },
  }
}
