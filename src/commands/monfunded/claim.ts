import type { CommandIO, InputSchema } from '@metamask/agent-wallet/plugin'
import { perform } from '../../host.ts'
import { parseHash32, valid } from '../../lib/inputs.ts'
import { claim } from '../../lib/payout.ts'
import { InputFieldType, PluginCommand, schemaToFlags } from '../../sdk.ts'

const inputs = {
  withdrawal: { type: InputFieldType.Text, flag: 'withdrawal', message: 'Withdrawal id, from `mm monfunded status`', required: true, validate: (v: string) => valid(() => parseHash32('withdrawal', v)) },
  yes: { type: InputFieldType.Boolean, flag: 'yes', message: 'Sign and claim without asking. Agents: only after the user approved the plan shown without it', required: false, prompt: false },
} satisfies InputSchema

export default class MonfundedClaim extends PluginCommand<Awaited<ReturnType<typeof claim>>> {
  static override description = 'Collect an unpaid MonFunded payout from the contract yourself, with the operator’s signature (you pay the gas). Explains a payout held for review. Shows the claim first; signs only with --yes or your yes.'
  static override examples = ['<%= config.bin %> monfunded claim --withdrawal 0x…', '<%= config.bin %> monfunded claim --withdrawal 0x… --yes']
  static override flags = schemaToFlags(inputs)
  protected readonly pluginCommandId = 'monfunded:claim'

  async execute(io: CommandIO) {
    const v = await io.resolveInputs(inputs)
    return perform(this.ctx, io, this.pluginCommandId, (d) => claim(d, { withdrawal: parseHash32('withdrawal', v.withdrawal) }), v.yes === true)
  }
}
