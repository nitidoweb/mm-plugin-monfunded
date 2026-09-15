import type { CommandIO } from '@metamask/agent-wallet/plugin'
import { perform } from '../../host.ts'
import { PluginCommand } from '../../sdk.ts'
import { login, type LoginResult } from '../../lib/login.ts'

export default class MonfundedLogin extends PluginCommand<LoginResult> {
  static override description = 'Sign in to MonFunded with the active wallet: MetaMask signs MonFunded’s sign-in message (no transaction, no gas) and the plugin keeps the 7-day session locally.'
  static override examples = ['<%= config.bin %> monfunded login', '<%= config.bin %> monfunded login --json']
  protected readonly pluginCommandId = 'monfunded:login'

  async execute(io: CommandIO) {
    return perform(this.ctx, io, this.pluginCommandId, login)
  }
}
