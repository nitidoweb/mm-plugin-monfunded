import type { CommandIO, InputSchema } from '@metamask/agent-wallet/plugin'
import { perform } from '../../host.ts'
import { buy } from '../../lib/buy.ts'
import { parseHash32, parsePay, parseSize, valid } from '../../lib/inputs.ts'
import { InputFieldType, PluginCommand, schemaToFlags } from '../../sdk.ts'

const inputs = {
  size: { type: InputFieldType.Text, flag: 'size', message: 'Account size: 10k, 25k, 50k, 100k or 200k', required: true, validate: (v: string) => valid(() => parseSize(v)) },
  pay: { type: InputFieldType.Text, flag: 'pay', message: 'Coin to pay the fee in: usdc, ausd or mon', required: true, validate: (v: string) => valid(() => parsePay(v)) },
  entryTx: { type: InputFieldType.Text, flag: 'entry-tx', message: 'Register an entry already paid on-chain (its transaction hash) without paying again', required: false, prompt: false, validate: (v: string) => valid(() => parseHash32('entry-tx', v)) },
  yes: { type: InputFieldType.Boolean, flag: 'yes', message: 'Sign and pay without asking. Agents: only after the user approved the plan shown without it', required: false, prompt: false },
} satisfies InputSchema

export default class MonfundedBuy extends PluginCommand<Awaited<ReturnType<typeof buy>>> {
  static override description = 'Buy a MonFunded assessment: pays the fee to the MonFunded contract on Monad in USDC, AUSD or MON. Shows the payment first; signs only with --yes or your yes.'
  static override examples = ['<%= config.bin %> monfunded buy --size 10k --pay usdc', '<%= config.bin %> monfunded buy --size 10k --pay usdc --yes', '<%= config.bin %> monfunded buy --size 25k --pay mon --json']
  static override flags = schemaToFlags(inputs)
  protected readonly pluginCommandId = 'monfunded:buy'

  async execute(io: CommandIO) {
    const v = await io.resolveInputs(inputs)
    return perform(this.ctx, io, this.pluginCommandId, (d) => buy(d, { size: parseSize(v.size), pay: parsePay(v.pay), ...(v.entryTx ? { entryTx: parseHash32('entry-tx', v.entryTx) } : {}) }), v.yes === true)
  }
}
