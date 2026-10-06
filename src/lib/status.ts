// `mm monfunded status`: whether entries are open, the plans, and, once signed in, every running
// account with its rule meters (profit target, daily loss room, drawdown room), positions,
// withdrawable profit and withdrawals. Signed out, it still answers (the check that the plugin
// works), and says how to sign in.
import type { Deps } from './context.ts'
import { planName, usd } from './format.ts'
import type { Challenge, Tier } from './types.ts'
import { accountView } from './views.ts'

const plansOf = (tiers: Tier[]) =>
  tiers.filter((t) => t.enabled !== false).map((t) => ({ plan: planName(t), id: t.id, size: t.size, feeUsd: t.feeUsd, profitTargetPct: t.rules.profitTargetPct, dailyLossPct: t.rules.dailyLossPct, maxDrawdownPct: t.rules.maxDrawdownPct, ...(t.rules.consistencyPct !== undefined && { consistencyPct: t.rules.consistencyPct }) }))

const pastOf = (c: Challenge) => ({ id: c.id, tier: c.tier, status: c.status, ...(c.reason && { reason: c.reason }), ...(c.endedAt !== undefined && { endedAt: new Date(c.endedAt).toISOString() }) })

export async function status(d: Deps) {
  const config = await d.api.config()
  const plans = plansOf(config.tiers)
  const entries = config.contract ? `Entries are open: fees go to the MonFunded contract ${config.contract} on Monad.` : 'Entries are closed right now: MonFunded names no contract to pay.'
  const base = { wallet: d.wallet, api: d.api.base, entriesOpen: config.contract !== null, contract: config.contract }
  const session = d.store.get(d.api.base, d.now())
  if (!session || session.address.toLowerCase() !== d.wallet.toLowerCase()) {
    const why = session ? `The saved MonFunded session is for ${session.address}, not the active wallet ${d.wallet}.` : `Not signed in to MonFunded (${d.api.base}).`
    return { ...base, signedIn: false, plans, summary: [why, 'Run `mm monfunded login` to sign in with the active wallet.', entries, `${plans.length} plans on sale, from ${usd(Math.min(...plans.map((p) => p.feeUsd)))}.`] }
  }
  d.api.useSession(session.cookie)
  const [me, prices] = await Promise.all([d.api.me(), d.api.prices()])
  const now = d.now()
  const accounts = me.active.map((c) => accountView(c, config.tiers, prices, now))
  const summary = [`Signed in to MonFunded (${d.api.base}) as ${d.wallet}.`, entries]
  if (!accounts.length) summary.push('No running account: buy one with `mm monfunded buy --size 10k --pay usdc`.')
  for (const a of accounts) summary.push(...a.summary)
  if (me.past.length) summary.push(`${me.past.length} ended account${me.past.length > 1 ? 's' : ''}.`)
  return { ...base, signedIn: true, sessionExpiresAt: new Date(session.expiresAt).toISOString(), accounts, pastAccounts: me.past.map(pastOf), plans, summary }
}
