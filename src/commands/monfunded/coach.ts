import type { CommandIO } from '@metamask/agent-wallet/plugin'
import { perform } from '../../host.ts'
import { coach } from '../../lib/trade.ts'
import { orderInputs, orderOf } from '../../orderInputs.ts'
import { PluginCommand, schemaToFlags } from '../../sdk.ts'

export default class MonfundedCoach extends PluginCommand<Awaited<ReturnType<typeof coach>>> {
  static override description = 'Check an intended order against MonFunded’s rules without sending it: the leverage cap, margin, and how far the price can move against you before the account fails or the position is liquidated.'
  static override examples = ['<%= config.bin %> monfunded coach --market BTC --side long --notional 1000 --leverage 2']
  static override flags = schemaToFlags(orderInputs)
  protected readonly pluginCommandId = 'monfunded:coach'

  async execute(io: CommandIO) {
    const v = await io.resolveInputs(orderInputs)
    return perform(this.ctx, io, this.pluginCommandId, (d) => coach(d, orderOf(v)))
  }
}
