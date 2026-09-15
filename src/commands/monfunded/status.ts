import type { CommandIO } from '@metamask/agent-wallet/plugin'
import { perform } from '../../host.ts'
import { PluginCommand } from '../../sdk.ts'
import { status } from '../../lib/status.ts'

export default class MonfundedStatus extends PluginCommand<Awaited<ReturnType<typeof status>>> {
  static override description = 'Show MonFunded accounts: balance, equity, rule meters (profit target, daily loss room, drawdown room), open positions, withdrawable profit and withdrawals. Signed out, shows the plans.'
  static override examples = ['<%= config.bin %> monfunded status', '<%= config.bin %> monfunded status --json']
  protected readonly pluginCommandId = 'monfunded:status'

  async execute(io: CommandIO) {
    return perform(this.ctx, io, this.pluginCommandId, status)
  }
}
