// Every flag's parser: the shapes it takes, the ones it refuses.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PluginError } from '../src/lib/errors.ts'
import { apiBase, apiTarget, parseHash32, parseLeverage, parseMarket, parsePay, parsePayoutToken, parsePositionId, parseRisk, parseSide, parseSize, parseUsd, valid } from '../src/lib/inputs.ts'

const refused = (run: () => unknown, code = 'INVALID_INPUT') => assert.throws(run, (e) => e instanceof PluginError && e.code === code)

test('sizes: 5k to 400k, or the whole number', () => {
  assert.equal(parseSize('5k'), 5000)
  assert.equal(parseSize('400K'), 400_000)
  assert.equal(parseSize(' 25000 '), 25_000)
  for (const bad of ['', '5', '5.5k', '$5k', '5,000', '-5k', '2000k', 'abc', '5 k', '5kk']) refused(() => parseSize(bad))
})

test('risk, coin and side: the listed words only (any case)', () => {
  assert.equal(parseRisk('TIGHT'), 'tight')
  assert.equal(parseRisk('medium'), 'medium')
  refused(() => parseRisk('loose'))
  assert.equal(parsePay('usdc'), 'USDC')
  assert.equal(parsePay('Mon'), 'MON')
  refused(() => parsePay('eth'))
  assert.equal(parsePayoutToken('ausd'), 'AUSD')
  refused(() => parsePayoutToken('mon'))
  assert.equal(parseSide('Long'), 'long')
  refused(() => parseSide('buy'))
})

test('markets: a symbol or a perpl: id, normalised to the id', () => {
  assert.equal(parseMarket('btc'), 'perpl:BTC')
  assert.equal(parseMarket('perpl:HYPE'), 'perpl:HYPE')
  for (const bad of ['', 'B', 'BTC-USD', 'perpl:', 'kuru:BTC', 'x'.repeat(11)]) refused(() => parseMarket(bad))
})

test('markets: a forex pair with the dollar on one side, as EURUSD, eur/usd or fx:USDJPY', () => {
  assert.equal(parseMarket('EURUSD'), 'fx:EURUSD')
  assert.equal(parseMarket('eur/usd'), 'fx:EURUSD')
  assert.equal(parseMarket('fx:USDJPY'), 'fx:USDJPY')
  // Without the dollar it is no pair MonFunded liquidity quotes: read as a Perpl symbol, which the server doesn't list.
  assert.equal(parseMarket('EURGBP'), 'perpl:EURGBP')
  refused(() => parseMarket('EUR/GBP'))
})

test('dollars: plain numbers, at most two decimals, at least the minimum', () => {
  assert.equal(parseUsd('notional', '250', 10), 250)
  assert.equal(parseUsd('notional', '99.5', 10), 99.5)
  for (const bad of ['9.99', '1e3', '-10', '10.001', '1,000', '$10', '', 'NaN']) refused(() => parseUsd('notional', bad, 10))
})

test('leverage: 1 to 100, an optional x', () => {
  assert.equal(parseLeverage('2'), 2)
  assert.equal(parseLeverage('3.5x'), 3.5)
  for (const bad of ['0', '0.5', '101', '2.555', 'max', '']) refused(() => parseLeverage(bad))
})

test('ids: 32-byte hex (lowercased) and position ids', () => {
  const id = `0x${'AB'.repeat(32)}`
  assert.equal(parseHash32('account', id), id.toLowerCase())
  for (const bad of ['0x1234', `${'ab'.repeat(32)}`, `0x${'zz'.repeat(32)}`]) refused(() => parseHash32('account', bad))
  assert.equal(parsePositionId('P1A2B3C4D5E6F'), 'p1a2b3c4d5e6f')
  for (const bad of ['p123', 'q1a2b3c4d5e6f', 'p1a2b3c4d5e6fa']) refused(() => parsePositionId(bad))
})

test('the API origin: monfunded.com; another (https, or http on this machine) only with the developer flag', () => {
  assert.deepEqual(apiBase(undefined), { base: 'https://monfunded.com', overridden: false })
  assert.deepEqual(apiBase('  '), { base: 'https://monfunded.com', overridden: false })
  assert.deepEqual(apiBase('https://monfunded.com/'), { base: 'https://monfunded.com', overridden: false })
  for (const url of ['http://localhost:4417', 'http://127.0.0.1:4417', 'https://staging.example.com'])
    assert.throws(
      () => apiBase(url),
      (e) => e instanceof PluginError && e.code === 'INVALID_API_URL' && e.message.includes(new URL(url).origin) && /MONFUNDED_DEV=1/.test(e.hint),
      url,
    )
  assert.deepEqual(apiBase('http://localhost:4417', true), { base: 'http://localhost:4417', overridden: true })
  assert.deepEqual(apiBase('http://127.0.0.1:4417', true), { base: 'http://127.0.0.1:4417', overridden: true })
  assert.deepEqual(apiBase('https://monfunded.com', true), { base: 'https://monfunded.com', overridden: false })
  for (const bad of ['http://monfunded.com', 'ftp://monfunded.com', 'https://monfunded.com/challenge', 'https://a:b@monfunded.com', 'https://monfunded.com/?x=1', 'http://192.168.1.5:4417', 'not a url']) for (const dev of [false, true]) refused(() => apiBase(bad, dev), 'INVALID_API_URL')
})

test('MONFUNDED_DEV=1 (exactly): a developer’s server, announced loudly on every command; the flag alone changes nothing', () => {
  const warned: string[] = []
  const warn = (line: string) => warned.push(line)
  assert.deepEqual(apiTarget({}, warn), { base: 'https://monfunded.com', dev: false })
  assert.deepEqual(warned, [], 'no flag, no warning')
  refused(() => apiTarget({ MONFUNDED_API_URL: 'http://localhost:4417' }, warn), 'INVALID_API_URL')
  for (const flag of ['true', 'yes', '0', ' 1', '1 ']) refused(() => apiTarget({ MONFUNDED_API_URL: 'http://localhost:4417', MONFUNDED_DEV: flag }, warn), 'INVALID_API_URL')
  assert.deepEqual(warned, [])
  assert.deepEqual(apiTarget({ MONFUNDED_API_URL: 'http://localhost:4417', MONFUNDED_DEV: '1' }, warn), { base: 'http://localhost:4417', dev: true })
  const loud = warned.join('\n')
  assert.match(loud, /^!{78}\nMONFUNDED_DEV=1: DEVELOPER MODE\. The plugin talks to http:\/\/localhost:4417, not https:\/\/monfunded\.com/)
  assert.match(loud, /whatever contract and MON book it names get paid/)
  assert.match(loud, /never with real money\.\n!{78}$/)
  warned.length = 0
  assert.deepEqual(apiTarget({ MONFUNDED_DEV: '1' }, warn), { base: 'https://monfunded.com', dev: false })
  assert.match(warned.join('\n'), /isn't: the plugin talks to https:\/\/monfunded\.com\nwith its usual pins/)
})

test('valid(): true, or the refusal in words for mm’s input prompts', () => {
  assert.equal(
    valid(() => parseSize('5k')),
    true,
  )
  assert.match(String(valid(() => parseSize('x'))), /^--size: "x" is not an account size\. Use 5k/)
})
