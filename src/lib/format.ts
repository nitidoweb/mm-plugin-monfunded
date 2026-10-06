// Numbers and names the way people read them in the plugin's summaries.
import { formatUnits } from 'viem'
import { EXPLORER_TX } from './constants.ts'
import type { Hex, Tier } from './types.ts'

const two = { minimumFractionDigits: 2, maximumFractionDigits: 2 }
// The figures come from the API: whatever it sent is printed as a number (NaN for text), never as
// its own words.
const figure = (n: number, options: Intl.NumberFormatOptions) => Number(n).toLocaleString('en-US', options)

// $1,234.56 and -$12.30.
export const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', two)}`
// +$12.30 for a gain, -$12.30 for a loss.
export const signedUsd = (n: number) => (n > 0 ? `+${usd(n)}` : usd(n))
// 30.00 USDC.
export const coin = (n: number, symbol: string) => `${figure(n, two)} ${symbol}`
// 406.1875 MON (wei to at most four decimals, rounded up so the figure is never short).
export const mon = (wei: bigint) => `${Number(formatUnits(wei + 10n ** 14n - 1n - ((wei + 10n ** 14n - 1n) % 10n ** 14n), 18)).toLocaleString('en-US', { maximumFractionDigits: 4 })} MON`
export const pct = (n: number) => `${figure(n, { maximumFractionDigits: 2 })} %`
// "$10,000", or the name the dashboard gave the plan.
export const planName = (tier: Pick<Tier, 'name' | 'size'>) => tier.name ?? `$${tier.size.toLocaleString('en-US')}`
export const txUrl = (hash: Hex) => `${EXPLORER_TX}${hash}`
// perpl:BTC → BTC, fx:EURUSD → EUR/USD, fx:GER30 → GER30.
export const symbolOf = (marketId: string) => marketId.replace(/^perpl:/, '').replace(/^fx:([A-Z]{3})([A-Z]{3})$/, '$1/$2').replace(/^fx:/, '')
