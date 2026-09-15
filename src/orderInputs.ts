// The flags `order` and `coach` share, as an mm input schema (outside src/lib, which never loads mm).
import type { InputSchema, ResolvedInputs } from '@metamask/agent-wallet/plugin'
import { parseHash32, parseLeverage, parseMarket, parseSide, parseUsd, valid } from './lib/inputs.ts'
import type { OrderInput } from './lib/trade.ts'
import { InputFieldType } from './sdk.ts'

export const orderInputs = {
  market: { type: InputFieldType.Text, flag: 'market', message: 'Market: a Perpl perp (BTC, ETH, SOL, MON, HYPE, ZEC, LIT, PUMP) or a forex pair (EURUSD, USDJPY, …)', required: true, validate: (v: string) => valid(() => parseMarket(v)) },
  side: { type: InputFieldType.Text, flag: 'side', message: 'Side: long (profits if the price rises) or short (if it falls)', required: true, validate: (v: string) => valid(() => parseSide(v)) },
  notional: { type: InputFieldType.Text, flag: 'notional', message: 'Position size in USD (at least 10)', required: true, validate: (v: string) => valid(() => parseUsd('notional', v, 10)) },
  leverage: { type: InputFieldType.Text, flag: 'leverage', message: 'Leverage, e.g. 2 (the plan and Perpl cap it; coach shows the cap)', required: true, validate: (v: string) => valid(() => parseLeverage(v)) },
  account: { type: InputFieldType.Text, flag: 'account', message: 'Account id, when the wallet has more than one running account', required: false, prompt: false, validate: (v: string) => valid(() => parseHash32('account', v)) },
} satisfies InputSchema

export const orderOf = (v: ResolvedInputs<typeof orderInputs>): OrderInput => ({
  market: parseMarket(v.market),
  side: parseSide(v.side),
  notional: parseUsd('notional', v.notional, 10),
  leverage: parseLeverage(v.leverage),
  ...(v.account ? { account: parseHash32('account', v.account) } : {}),
})
