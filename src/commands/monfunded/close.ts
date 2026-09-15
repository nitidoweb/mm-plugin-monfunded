import type { CommandIO, InputSchema } from '@metamask/agent-wallet/plugin'
import { perform } from '../../host.ts'
import { parseHash32, parsePositionId, valid } from '../../lib/inputs.ts'
import { close } from '../../lib/trade.ts'
import { InputFieldType, PluginCommand, schemaToFlags } from '../../sdk.ts'

const inputs = {
  position: { type: InputFieldType.Text, flag: 'position', message: 'Position id, from `mm monfunded status` (like p1a2b3c4d5e6f)', required: true, validate: (v: string) => valid(() => parsePositionId(v)) },
  account: { type: InputFieldType.Text, flag: 'account', message: 'Account id, to narrow the search to one account', required: false, prompt: false, validate: (v: string) => valid(() => parseHash32('account', v)) },
} satisfies InputSchema

export default class MonfundedClose extends PluginCommand<Awaited<ReturnType<typeof close>>> {
  static override description = 'Close a position on a MonFunded account once its 60-second minimum hold is over (a pending order is cancelled instead) and wait for the close. Nothing is signed.'
  static override examples = ['<%= config.bin %> monfunded close --position p1a2b3c4d5e6f']
  static override flags = schemaToFlags(inputs)
  protected readonly pluginCommandId = 'monfunded:close'

  async execute(io: CommandIO) {
    const v = await io.resolveInputs(inputs)
    return perform(this.ctx, io, this.pluginCommandId, (d) => close(d, { position: parsePositionId(v.position), ...(v.account ? { account: parseHash32('account', v.account) } : {}) }))
  }
}
