import type { CommandIO, InputSchema } from '@metamask/agent-wallet/plugin'
import { perform } from '../../host.ts'
import { parseHash32, parsePayoutToken, valid } from '../../lib/inputs.ts'
import { withdraw } from '../../lib/payout.ts'
import { InputFieldType, PluginCommand, schemaToFlags } from '../../sdk.ts'

const inputs = {
  token: { type: InputFieldType.Text, flag: 'token', message: 'Coin to be paid in: usdc or ausd', required: true, validate: (v: string) => valid(() => parsePayoutToken(v)) },
  account: { type: InputFieldType.Text, flag: 'account', message: 'Funded account id, when the wallet has more than one', required: false, prompt: false, validate: (v: string) => valid(() => parseHash32('account', v)) },
  yes: { type: InputFieldType.Boolean, flag: 'yes', message: 'Withdraw without asking. Agents: only after the user approved the plan shown without it', required: false, prompt: false },
} satisfies InputSchema

export default class MonfundedWithdraw extends PluginCommand<Awaited<ReturnType<typeof withdraw>>> {
  static override description = 'Take all the profit off a funded MonFunded account at once: you receive 80 % of it in USDC or AUSD, paid by the MonFunded contract to this wallet. The account pauses until the payout is released or declined. Shows the payout first; goes ahead only with --yes or your yes.'
  static override examples = ['<%= config.bin %> monfunded withdraw --token usdc', '<%= config.bin %> monfunded withdraw --token ausd --yes']
  static override flags = schemaToFlags(inputs)
  protected readonly pluginCommandId = 'monfunded:withdraw'

  async execute(io: CommandIO) {
    const v = await io.resolveInputs(inputs)
    return perform(this.ctx, io, this.pluginCommandId, (d) => withdraw(d, { token: parsePayoutToken(v.token), ...(v.account ? { account: parseHash32('account', v.account) } : {}) }), v.yes === true)
  }
}
