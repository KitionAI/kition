// Copied from kition-sdk packages/script/src/drafts.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The person's side of headless drafts (Kit Harness Protocol (KHP) A12 to A15): an agent working through
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
  /** `replica`: a fork of the file's replica; `file`: a copy of the file. Either can have an object comparison. */
  mode: 'replica' | 'file'
  /** In `file` mode: the kit's error that kept the draft from forking the file's replica. */
  replicaError?: string
  state: 'open' | 'ready'
  /** The file's SHA-256 when the draft forked. */
  baseSha256: string
  /** Unix milliseconds. */
  created: number
  updated: number
  /** The file changed since the draft forked: merging is refused unless `overwrite`. */
  stale: boolean
}

/** The same object id form receipts use: integer tool ids stay numbers. */
export type DraftObjectId = string | number

export type DraftPosition = { parent: DraftObjectId; field: string; index: number }

/** A JSON field value; long values use the receipt's `{ excerpt, length }` object. */
export type DraftValue = null | boolean | number | string | DraftValue[] | { [key: string]: DraftValue }

export type DraftObjectChange = {
  id: DraftObjectId
  type: string
  fields: string[]
  values?: Record<string, DraftValue>
  at?: DraftPosition
  edits?: Array<{ field: string; before: DraftValue; after: DraftValue; named?: string }>
}

/** The generic receipt change set a person reviews (A13), with bounded text values. */
export type DraftDiff = {
  created: DraftObjectChange[]
  changed: DraftObjectChange[]
  moved: Array<{ id: DraftObjectId; type: string; from: DraftPosition | null; to: DraftPosition | null }>
  deleted: DraftObjectChange[]
  texts: Array<{ id: DraftObjectId; field: string; before: string | { excerpt: string; length: number }; after: string | { excerpt: string; length: number } }>
  /** Ambiguous identities on reread, in the generic diff's string form. */
  renumbered?: string[]
  /** Omitted entries by list; nested counts aggregate across retained entries. Absent if complete. */
  truncated?: {
    created: number
    changed: number
    moved: number
    deleted: number
    texts?: number
    renumbered?: number
    fields?: number
    edits?: number
    members?: number
    values?: number
  }
}

/** What `drafts compare` answers. */
export type DraftComparison = {
  path: string
  kit: string
  mode: 'replica' | 'file'
  state: 'open' | 'ready'
  stale: boolean
  /** Bounded object comparison in either mode; `null` when unavailable (`diffUnavailable` says why). */
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
  /** Kit executables by kit (`{ note: 'bin/kition-note' }`), passed as `--kit`. */
  kits?: Record<string, string>
  /** A folder of `kition-<kit>` executables (`--kits-dir`). */
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
