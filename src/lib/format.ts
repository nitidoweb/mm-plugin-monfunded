// Numbers and names the way people read them in the plugin's summaries.
import { formatUnits } from 'viem'
import { EXPLORER_TX } from './constants.ts'
import type { Hex, Tier } from './types.ts'

const two = { minimumFractionDigits: 2, maximumFractionDigits: 2 }

// $1,234.56 and -$12.30.
export const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', two)}`
// +$12.30 for a gain, -$12.30 for a loss.
export const signedUsd = (n: number) => (n > 0 ? `+${usd(n)}` : usd(n))
// 30.00 USDC.
export const coin = (n: number, symbol: string) => `${n.toLocaleString('en-US', two)} ${symbol}`
// 406.1875 MON (wei to at most four decimals, rounded up so the figure is never short).
export const mon = (wei: bigint) => `${Number(formatUnits(wei + 10n ** 14n - 1n - ((wei + 10n ** 14n - 1n) % 10n ** 14n), 18)).toLocaleString('en-US', { maximumFractionDigits: 4 })} MON`
export const pct = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} %`
// "Tight $5,000", or the name the dashboard gave the plan.
export const planName = (tier: Pick<Tier, 'name' | 'risk' | 'size'>) => tier.name ?? `${tier.risk === 'tight' ? 'Tight' : 'Medium'} $${tier.size.toLocaleString('en-US')}`
export const txUrl = (hash: Hex) => `${EXPLORER_TX}${hash}`
// perpl:BTC → BTC.
export const symbolOf = (marketId: string) => marketId.replace(/^perpl:/, '')
