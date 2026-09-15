// The MON price of a fee paid in MON. The contract sells the MON on Kuru's MON_USDC book, so the
// quote walks that book's bids the way the app does (src/lib/challengeQuote.ts in the MonFunded
// repository): Kuru's taker fee grossed up, a 0.5 % buffer on top (the surplus USDC stays in the
// reserve), rounded up to the book's size grid.
import type { Fetch } from './api.ts'
import { KURU_API, MON_BOOK, MON_QUOTE_BUFFER_BPS, MON_SIZE_GRID, REQUEST_TIMEOUT_MS } from './constants.ts'
import { PluginError } from './errors.ts'
import type { Address } from './types.ts'

export type Level = { price: number; size: number }

// Kuru's exchange API: prices are fixed-point with 18 decimals, sizes scaled by the book's
// sizePrecision.
const PRICE_SCALE = 1e18

const unavailable = (why: string) => new PluginError('KURU_UNAVAILABLE', `Kuru’s market data did not answer (${why}), so the fee can’t be priced in MON.`, 'Pay with --pay usdc or --pay ausd, or try again in a minute.')

// The MON that sells for at least `usdOut` USDC against `bids` (best price first; each level's
// `size` in MON at `price` USDC per MON) after the taker fee, plus `bufferBps`.
export function monForUsdc(bids: Level[], usdOut: number, takerFeeBps = 0, bufferBps = MON_QUOTE_BUFFER_BPS): number {
  if (!(usdOut > 0)) return 0
  let left = usdOut / (1 - takerFeeBps / 10_000)
  let mon = 0
  for (const { price, size } of [...bids].sort((a, b) => b.price - a.price)) {
    if (!(price > 0) || !(size > 0)) continue
    const levelUsd = price * size
    if (left <= levelUsd) {
      mon += left / price
      left = 0
      break
    }
    mon += size
    left -= levelUsd
  }
  if (left > 0) throw new PluginError('NO_LIQUIDITY', 'Kuru’s MON_USDC book is too thin to sell enough MON for this fee right now.', 'Pay with --pay usdc or --pay ausd, or try again later.')
  return mon * (1 + bufferBps / 10_000)
}

// MON → wei, rounded up to the book's size grid (whole MON exact, the fraction to 1e-10 MON).
export function monToWei(mon: number): bigint {
  const whole = Math.floor(mon)
  const gridUnits = BigInt(Math.ceil((mon - whole) * 1e10))
  return BigInt(whole) * 10n ** 18n + gridUnits * MON_SIZE_GRID
}

async function kuruJson<T>(fetchFn: Fetch, path: string): Promise<T> {
  let res: Response
  try {
    res = await fetchFn(`${KURU_API}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' })
  } catch (e) {
    throw unavailable(e instanceof Error ? e.message : String(e))
  }
  if (!res.ok) throw unavailable(`HTTP ${res.status}`)
  try {
    return (await res.json()) as T
  } catch {
    throw unavailable('not JSON')
  }
}

type BookInfo = { symbol?: string; marketAddress?: string; sizePrecision?: string | number; takerFeeBps?: number }

// The MON (in wei) that pays `feeUsd` on `market`, which must be the book Kuru lists as MON_USDC
// (the contract's /config.monMarket), and the book's best bid.
export async function quoteMonFee(fetchFn: Fetch, feeUsd: number, market: Address): Promise<{ monWei: bigint; bestBid: number }> {
  const [info, depth] = await Promise.all([
    kuruJson<{ symbols?: BookInfo[] }>(fetchFn, '/api/v3/exchangeInfo'),
    kuruJson<{ bids?: [string, string][] }>(fetchFn, `/api/v3/depth?symbol=${MON_BOOK}&limit=100`),
  ])
  const book = info.symbols?.find((s) => s.symbol === MON_BOOK)
  if (!book?.marketAddress || book.marketAddress.toLowerCase() !== market.toLowerCase()) throw new PluginError('MON_BOOK_MISMATCH', 'Kuru’s MON_USDC book is not the one MonFunded’s contract swaps on, so the MON price can’t be trusted.', 'Pay with --pay usdc or --pay ausd.')
  const sizeScale = Number(book.sizePrecision ?? PRICE_SCALE)
  const bids = (depth.bids ?? []).map(([price, size]) => ({ price: Number(price) / PRICE_SCALE, size: Number(size) / sizeScale }))
  const mon = monForUsdc(bids, feeUsd, Number(book.takerFeeBps ?? 0))
  return { monWei: monToWei(mon), bestBid: Math.max(0, ...bids.map((b) => b.price)) }
}
