// The MON price of a fee: the same figures as the app's quote (scripts/challenge-quote.test.ts in the
// MonFunded repository), and Kuru's book read and checked.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PluginError } from '../src/lib/errors.ts'
import { monForUsdc, monToWei, quoteMonFee } from '../src/lib/kuru.ts'
import { MON_MARKET, response } from './fakes.ts'

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`)
const BOOK = [
  { price: 0.24, size: 1000 },
  { price: 0.25, size: 300 },
  { price: 0.2, size: 5000 },
]

test('the fee walks the bids best first, grosses up the taker fee, adds the 0.5 % buffer', () => {
  close(monForUsdc(BOOK, 50, 0, 0), 200)
  close(monForUsdc(BOOK, 50), 201)
  close(monForUsdc(BOOK, 100, 0, 0), 300 + 25 / 0.24)
  close(monForUsdc(BOOK, 50, 30, 0), 50 / 0.997 / 0.25)
  assert.equal(monForUsdc(BOOK, 0), 0)
  assert.throws(() => monForUsdc(BOOK, 1316), (e) => e instanceof PluginError && e.code === 'NO_LIQUIDITY')
})

test('MON becomes wei rounded up to the book’s 1e8 wei grid', () => {
  assert.equal(monToWei(1), 10n ** 18n)
  assert.equal(monToWei(1e-11), 10n ** 8n)
  assert.equal(monToWei(406.1875), 406_187_500_000_000_000_000n)
})

const kuru = (market: string) => async (url: string) =>
  url.includes('exchangeInfo')
    ? response(200, JSON.stringify({ symbols: [{ symbol: 'MON_USDC', marketAddress: market, sizePrecision: '10000000000', takerFeeBps: 0 }] }))
    : response(200, JSON.stringify({ bids: [[String(0.25e18), String(300 * 1e10)]] }))

test('the quote reads Kuru’s MON_USDC book, only if it is the contract’s', async () => {
  const q = await quoteMonFee(kuru(MON_MARKET.toLowerCase()), 30, MON_MARKET)
  assert.equal(q.monWei, 120_600_000_000_000_000_000n)
  assert.equal(q.bestBid, 0.25)
  await assert.rejects(quoteMonFee(kuru('0x0000000000000000000000000000000000000001'), 30, MON_MARKET), (e) => e instanceof PluginError && e.code === 'MON_BOOK_MISMATCH')
  await assert.rejects(quoteMonFee(async () => response(502, 'bad gateway'), 30, MON_MARKET), (e) => e instanceof PluginError && e.code === 'KURU_UNAVAILABLE')
})
