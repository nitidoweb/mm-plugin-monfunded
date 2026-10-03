// The MonFundedChallenge contract (contracts/MonFundedChallenge.sol, v3) and the two coins on
// Monad: the calls the plugin sends through MetaMask, and the reads it makes first (through mm's
// own authenticated RPC client) so nothing is signed that would revert or pay the wrong amount.
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress, type PublicClient } from 'viem'
import { KURU_ROUTER, RECEIPT_TIMEOUT_MS, USDC } from './constants.ts'
import type { Address, Hex, PayoutToken } from './types.ts'

export const CHALLENGE_ABI = parseAbi([
  'function enter(uint8 tier)',
  'function enterWithAusd(uint8 tier)',
  'function enterWithMon(uint8 tier, address market, uint256 minUsdcOut, uint256 deadline) payable',
  'function claim(bytes32 withdrawalId, address token, uint256 amount, bytes32 logRoot, bytes signature)',
  'function tiers(uint8 tier) view returns (uint256)',
  'function paid(bytes32 withdrawalId) view returns (bool)',
  'function usdc() view returns (address)',
  'function ausd() view returns (address)',
  'function router() view returns (address)',
])

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
])

// Kuru's router: the one swap a MON fee makes inside the contract.
const ROUTER_ABI = parseAbi(['function anyToAnySwap(address[] marketAddresses, bool[] isBuy, bool[] nativeSend, address debitToken, address creditToken, uint256 amount, uint256 minAmountOut) payable returns (uint256)'])

// USD in the coins' 6-decimal units (USDC and AUSD alike), the same rounding as the server's
// usd6, so a claim's amount matches the operator's signature to the unit.
export const usd6 = (usd: number) => BigInt(Math.round(usd * 1_000_000))

// One transaction for MetaMask to sign and send.
export type Call = { to: Address; data: Hex; value: bigint }

// approve(spender, amount): exactly the fee, never an open-ended allowance.
export const approveCall = (token: Address, spender: Address, amount: bigint): Call => ({ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }), value: 0n })

// enter(index) pays the plan's fee in USDC, enterWithAusd(index) the same fee in AUSD.
export const enterCall = (contract: Address, index: number, coin: PayoutToken): Call => ({ to: contract, data: encodeFunctionData({ abi: CHALLENGE_ABI, functionName: coin === 'AUSD' ? 'enterWithAusd' : 'enter', args: [index] }), value: 0n })

// enterWithMon(index, market, minUsdcOut, deadline): `monWei` is sold for USDC on Kuru's MON_USDC
// book inside the contract, which keeps the fee and sends the rest back; `minUsdcOut` is the router's
// own floor (kuru.ts floorFromSwap, never under the fee), so a moved book reverts instead of
// underpaying, and `deadline` the last block time (seconds) it may land at.
export const enterWithMonCall = (contract: Address, index: number, market: Address, minUsdcOut: bigint, deadline: bigint, monWei: bigint): Call => ({ to: contract, data: encodeFunctionData({ abi: CHALLENGE_ABI, functionName: 'enterWithMon', args: [index, market, minUsdcOut, deadline] }), value: monWei })

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
  // The router the contract's enterWithMon swaps through.
  router(contract: Address): Promise<Address>
  // The latest block's time (seconds): the clock the contract's deadline is read against.
  chainTime(): Promise<bigint>
  // What `wei` MON sells for in USDC (6 decimals) on `market` right now: the router's own swap, asked
  // of the chain as a call (nothing is sent), never Kuru's HTTP API.
  simulateMonSwap(trader: Address, market: Address, wei: bigint): Promise<bigint>
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
    router: async (contract) => getAddress(await client.readContract({ address: contract, abi: CHALLENGE_ABI, functionName: 'router' })),
    chainTime: async () => (await client.getBlock()).timestamp,
    // A plain call from the wallet, no balance override: buy.ts has already checked it holds the MON
    // and Monad's 10 MON reserve, and MetaMask's own RPC may not take overrides (then every MON fee
    // would be refused as unconfirmed).
    simulateMonSwap: async (trader, market, wei) => {
      const { data } = await client.call({
        account: trader,
        to: KURU_ROUTER,
        value: wei,
        data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'anyToAnySwap', args: [[market], [false], [true], zeroAddress, USDC, wei, 0n] }),
      })
      if (!data) throw new Error('the router gave no answer')
      return decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'anyToAnySwap', data })
    },
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
