// The plugin's own local state: the MonFunded session cookie per API origin, in one file only this
// user can read (~/.monfunded/agent-session.json, the folder 0700 and the file 0600; the folder
// moves with MONFUNDED_AGENT_HOME). mm gives plugins no storage of their own, and the cookie is
// never printed: commands show the signed-in address and this file's path instead.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME_ENV } from './constants.ts'
import type { Address } from './types.ts'

export type Session = { address: Address; cookie: string; expiresAt: number }
type Saved = { v: 1; sessions: Record<string, Session> }

const isSession = (s: unknown): s is Session => {
  const x = s as Session | null
  return typeof x?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x.address) && typeof x.cookie === 'string' && /^[0-9a-f]{64}$/.test(x.cookie) && Number.isFinite(x.expiresAt)
}

export const storeDir = (env: Record<string, string | undefined>) => env[HOME_ENV]?.trim() || join(homedir(), '.monfunded')

export class SessionStore {
  readonly file: string
  readonly #dir: string

  constructor(dir: string) {
    this.#dir = dir
    this.file = join(dir, 'agent-session.json')
  }

  // Every well-formed session in the file; a missing or damaged file reads as none.
  #read(): Record<string, Session> {
    let saved: Partial<Saved>
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
    const out: Record<string, Session> = {}
    for (const [api, s] of Object.entries(saved?.sessions ?? {})) if (isSession(s)) out[api] = s
    return out
  }

  #write(sessions: Record<string, Session>) {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    chmodSync(this.#dir, 0o700)
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ v: 1, sessions } satisfies Saved, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  // The session for an API origin, unless it has expired.
  get(api: string, now: number): Session | undefined {
    const s = this.#read()[api]
    return s && s.expiresAt > now ? s : undefined
  }

  save(api: string, session: Session) {
    this.#write({ ...this.#read(), [api]: session })
  }

  // Forgets an origin's session (the file goes once it holds none).
  forget(api: string) {
    const { [api]: _gone, ...rest } = this.#read()
    if (Object.keys(rest).length) this.#write(rest)
    else rmSync(this.file, { force: true })
  }
}
