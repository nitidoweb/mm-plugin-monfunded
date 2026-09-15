// The plugin's manifest (package.json#mm) matches its commands: one entry per command file, the id
// each class declares, wallet-submit only where MetaMask signs, Monad only.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { VERSION } from '../src/lib/constants.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const commandsDir = new URL('../src/commands/monfunded/', import.meta.url)
const files = readdirSync(commandsDir).filter((f) => f.endsWith('.ts'))
// The commands whose flows ask MetaMask to sign: the sign-in message, the fee, the claim.
const SIGNING = new Set(['login', 'buy', 'claim'])

test('one manifest entry per command file, with the id its class declares', () => {
  const ids = pkg.mm.commands.map((c: { id: string }) => c.id).sort()
  assert.deepEqual(ids, files.map((f) => `monfunded:${f.replace(/\.ts$/, '')}`).sort())
  for (const f of files) assert.match(readFileSync(new URL(f, commandsDir), 'utf8'), new RegExp(`pluginCommandId = 'monfunded:${f.replace(/\.ts$/, '')}'`))
})

test('capabilities: wallet-read everywhere, wallet-submit only where MetaMask signs, Monad only', () => {
  assert.equal(pkg.mm.schemaVersion, 1)
  assert.equal(pkg.mm.minCliVersion, '^6.2.0')
  assert.deepEqual(pkg.mm.capabilities, [])
  for (const c of pkg.mm.commands) {
    const name = c.id.replace('monfunded:', '')
    assert.deepEqual(c.capabilities, SIGNING.has(name) ? ['wallet-read', 'wallet-submit'] : ['wallet-read'], c.id)
    assert.deepEqual(c.targetChains, [143], c.id)
    assert.ok(c.dataAccess.includes('accounts'), c.id)
  }
})

test('the version the plugin reports is the package’s', () => {
  assert.equal(VERSION, pkg.version)
})
