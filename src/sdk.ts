// mm's plugin SDK (@metamask/agent-wallet/plugin), taken from the mm that is running.
//
// A plugin must share mm's own instance of the SDK: a second copy boots a second CLI in the same
// process, which crashes ("window.addEventListener is not a function") and would split the grant
// index mm's capability checks use. mm links itself into its plugin folder so that plugins it
// copies there resolve to it, but a plugin installed from a local folder (mm plugins install
// "file:$PWD", as README.md says) stays a symlink, and Node resolves its imports from the folder's
// real path, where `npm install` put the development copy of the CLI. So the SDK comes from the
// running CLI's own package (the @metamask/agent-wallet folder above process.argv[1], mm's
// executable, through that package's public exports). Normal resolution is the fallback when
// something other than mm loads the plugin.
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Sdk from '@metamask/agent-wallet/plugin'

const HOST = '@metamask/agent-wallet'

type PackageJson = { name?: string; exports?: Record<string, { import?: string } | undefined> }

function readPackage(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

// The running mm's SDK entry: the ./plugin export of the @metamask/agent-wallet package that holds
// its executable, if mm is what is running.
function hostEntry(): string | undefined {
  let dir: string
  try {
    dir = dirname(realpathSync(process.argv[1] ?? ''))
  } catch {
    return undefined
  }
  for (;;) {
    const pkg = readPackage(dir)
    if (pkg?.name === HOST) {
      const entry = pkg.exports?.['./plugin']?.import
      return typeof entry === 'string' ? pathToFileURL(join(dir, entry)).href : undefined
    }
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

const entry = hostEntry()
const sdk: typeof Sdk = entry ? await import(entry) : await import('@metamask/agent-wallet/plugin')

export const { CommandError, InputFieldType, PluginCommand, schemaToFlags } = sdk
