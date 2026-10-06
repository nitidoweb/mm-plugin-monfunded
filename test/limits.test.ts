// The limits the plugin checks before a fee is paid are the server's own: a different number here
// means a fee paid and an entry refused.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MARGIN_CALL_PCT, MAX_ASSESSMENTS, MAX_FUNDED_USD, STOP_OUT_PCT } from '../src/lib/constants.ts'

test('the plugin’s limits are the server’s: assessments at once, funded size per wallet, the margin call and the stop-out', async () => {
  // The server's rules are plain JavaScript in the repository this folder sits in (a path the type checker doesn't follow).
  const server: Record<string, unknown> = await import(new URL('../../server/challenge-rules.mjs', import.meta.url).href)
  assert.equal(MAX_ASSESSMENTS, server.MAX_ASSESSMENTS_PER_ADDRESS)
  assert.equal(MAX_FUNDED_USD, server.MAX_ACTIVE_USD_PER_ADDRESS)
  assert.equal(MARGIN_CALL_PCT, server.MARGIN_CALL_PCT)
  assert.equal(STOP_OUT_PCT, server.STOP_OUT_PCT)
})
