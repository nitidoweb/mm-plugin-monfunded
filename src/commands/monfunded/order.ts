import type { CommandIO } from '@metamask/agent-wallet/plugin'
import { perform } from '../../host.ts'
import { order } from '../../lib/trade.ts'
import { orderInputs, orderOf } from '../../orderInputs.ts'
import { PluginCommand, schemaToFlags } from '../../sdk.ts'

export default class MonfundedOrder extends PluginCommand<Awaited<ReturnType<typeof order>>> {
  static override description = 'Open a long or short position on a MonFunded account (Perpl’s BTC, ETH, SOL, MON, HYPE, ZEC, LIT or PUMP perp, simulated at Perpl’s live prices) and wait for its fill. Nothing is signed.'
  static override examples = ['<%= config.bin %> monfunded order --market BTC --side long --notional 1000 --leverage 2', '<%= config.bin %> monfunded order --market ETH --side short --notional 500 --leverage 3 --account 0x…']
  static override flags = schemaToFlags(orderInputs)
  protected readonly pluginCommandId = 'monfunded:order'

  async execute(io: CommandIO) {
    const v = await io.resolveInputs(orderInputs)
    return perform(this.ctx, io, this.pluginCommandId, (d) => order(d, orderOf(v)))
  }
}
