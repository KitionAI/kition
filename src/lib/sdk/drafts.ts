// Copied from kition-sdk packages/sdk/src/drafts.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The person's side of headless drafts (Kit Standard A12 to A15): an agent working through
 * `kition-kits-mcp` keeps its drafts in the workspace's `.kition/drafts/`; a page's server lists
 * them, shows their comparison, and merges or discards one when the person says so, by running
 * `kition-kits-mcp drafts`. Never offer these to an agent: merging is the person's alone (A14).
 */
import { execFile } from 'node:child_process'

/** A draft as `drafts list` answers it. */
export type WorkspaceDraft = {
  version: 1
  /** The file's workspace path. */
  path: string
  kit: string
  /** `replica`: a fork of the file's replica (its comparison has the object difference); `file`: a copy of the file. */
  mode: 'replica' | 'file'
  state: 'open' | 'ready'
  /** The file's SHA-256 when the draft forked. */
  baseSha256: string
  /** Unix milliseconds. */
  created: number
  updated: number
  /** The file changed since the draft forked: merging is refused unless `overwrite`. */
  stale: boolean
}

/** The object-level difference a person reviews (A13). */
export type DraftDiff = {
  created: Array<{ id: string; type: string; fields: string[] }>
  changed: Array<{ id: string; type: string; fields: string[] }>
  deleted: Array<{ id: string; type: string; fields: string[] }>
  texts: Array<{ id: string; field: string; before: string; after: string }>
}

/** What `drafts compare` answers. */
export type DraftComparison = {
  path: string
  kit: string
  mode: 'replica' | 'file'
  state: 'open' | 'ready'
  stale: boolean
  /** `null` for `file` drafts, or when the kit does not describe its objects (`diffUnavailable` says why). */
  diff: DraftDiff | null
  diffUnavailable?: string
  /** One line on each side, from the kit. */
  summary: { base?: string; draft?: string }
  /** With `previews`: both sides rendered by the kit, base64 PNG. */
  previews?: { base?: string; draft?: string }
}

/** A refused command: `not-found`, `stale`, or a kit tool error code. */
export class DraftCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DraftCommandError'
  }
}

export type WorkspaceDraftsOptions = {
  /** The `kition-kits-mcp` executable. */
  server: string
  /** Arguments before `drafts`, for a server started through another program. */
  serverArgs?: string[]
  /** The workspace folder the agent's server works in. */
  workspace: string
  /** Kit executables by kit (`{ slide: 'bin/kit-slide' }`), passed as `--kit`. */
  kits?: Record<string, string>
  /** A folder of `kit-<kit>` executables (`--kits-dir`). */
  kitsDir?: string
  env?: NodeJS.ProcessEnv
}

export type WorkspaceDrafts = {
  list: () => Promise<WorkspaceDraft[]>
  compare: (path: string, options?: { previews?: boolean }) => Promise<DraftComparison>
  /** Writes the draft as the file. Refused (`stale`) when the file changed since the draft forked, unless `overwrite`. */
  merge: (path: string, options?: { overwrite?: boolean }) => Promise<{ path: string; merged: true; sha256: string }>
  discard: (path: string) => Promise<{ path: string; discarded: true }>
}

/** The drafts of `options.workspace`, through `kition-kits-mcp drafts`. */
export function workspaceDrafts(options: WorkspaceDraftsOptions): WorkspaceDrafts {
  const shared = ['--workspace', options.workspace]
  for (const [kit, binary] of Object.entries(options.kits ?? {})) shared.push('--kit', `${kit}=${binary}`)
  if (options.kitsDir) shared.push('--kits-dir', options.kitsDir)
  const run = (args: string[]) =>
    new Promise<unknown>((resolve, reject) => {
      execFile(options.server, [...(options.serverArgs ?? []), 'drafts', ...args, ...shared], { env: options.env ?? process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        let answer: { error?: { code?: string; message?: string } } | undefined
        try {
          answer = JSON.parse(stdout) as typeof answer
        } catch {
          reject(error ?? new Error(`kition-kits-mcp drafts printed no JSON: ${stdout.slice(0, 200)}`))
          return
        }
        if (answer?.error) reject(new DraftCommandError(answer.error.code ?? 'failed', answer.error.message ?? 'refused'))
        else if (error) reject(error)
        else resolve(answer)
      })
    })
  return {
    list: async () => ((await run(['list'])) as { drafts: WorkspaceDraft[] }).drafts,
    compare: async (path, compareOptions) => (await run(['compare', path, ...(compareOptions?.previews ? ['--previews'] : [])])) as DraftComparison,
    merge: async (path, mergeOptions) => (await run(['merge', path, ...(mergeOptions?.overwrite ? ['--overwrite'] : [])])) as { path: string; merged: true; sha256: string },
    discard: async (path) => (await run(['discard', path])) as { path: string; discarded: true },
  }
}
