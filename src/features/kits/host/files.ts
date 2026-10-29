// Copied from kition-sdk packages/kit-host/src/files.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The host's side of KitFiles 1.0 (Kition platform `docs/platform/sets/files.md`; Kit UI protocol section
 * 7g): a session's grant table (handle → session, kit, principal, rights, kind), the `files/*`
 * requests served from it with the host's own storage, staged writes, and names that never
 * replace a file. The host's storage speaks in its own references (`KitFileRef`, such as a
 * workspace path); they never leave this module: the kit sees only handles and display names
 * (FA-P2, UI-F1).
 */
import {
  FILE_HANDLE_PREFIX,
  KitRpcError,
  type KitFileErrorReason,
  type KitFileRight,
  type KitFileStat,
  type KitFilesCreateParams,
  type KitFilesPickParams,
  type KitFilesPrintParams,
  type KitFilesWriteParams,
  type KitToHost,
} from './protocol'

/** The host's own name for a file or folder (a workspace path). The kit never sees it. */
export type KitFileRef = string

/** A file or folder as the host's storage sees it now. */
export type KitFileEntry = { kind: 'file' | 'folder'; size?: number; mime?: string; version: string | null }

/** A write in progress, kept by the storage (a temporary file) until it commits or is aborted. */
export type KitFileStaging = {
  append: (bytes: Uint8Array) => Promise<void>
  /** Commits atomically (temporary file, then rename, H4), as `commit` does with the staged bytes. */
  commit: () => Promise<{ version: string }>
  abort: () => Promise<void>
}

/** How a staged write commits: a new file (never an existing one), or a replacement of the version the kit read. */
export type KitFileCommitMode = { mode: 'create' } | { mode: 'replace'; expected: string }

/**
 * The host's storage, in its own references. Every answer about a file the kit may not see (outside
 * the workspace, the host's own data, a hidden path; H3, LR2, FA8) is the same as for a missing file.
 */
export type KitFilesStorage = {
  /** The file or folder at `ref`; `null` when there is none or the kit may not see it. */
  stat: (ref: KitFileRef) => KitFileEntry | null | Promise<KitFileEntry | null>
  /** At most `length` bytes from `offset` (to the end without `length`); `size` is the whole file's. */
  read: (ref: KitFileRef, offset: number, length: number | undefined) => Promise<{ bytes: ArrayBuffer; version: string; size: number }>
  /** A folder's entries, not recursively. */
  list: (ref: KitFileRef) => KitFileRef[] | Promise<KitFileRef[]>
  /** The reference of `name` in `folder`; `null` is the document's own folder. */
  child: (folder: KitFileRef | null, name: string) => KitFileRef
  /** The display name of `ref`: its last segment. Default: what follows the last `/` or `\`. */
  name?: (ref: KitFileRef) => string
  /**
   * Puts `bytes` at `ref` atomically. `create` MUST refuse a file that exists (throw `fileError('conflict')`);
   * `replace` MUST refuse unless the file's version is still `expected` (`conflict`).
   */
  commit: (ref: KitFileRef, bytes: Uint8Array, mode: KitFileCommitMode) => Promise<{ version: string }>
  /** Stages a write elsewhere than in memory (a temporary file), for exports of any length. Absent: staged in memory, then `commit`. */
  stage?: (ref: KitFileRef, mode: () => KitFileCommitMode) => KitFileStaging
  /** The file is open with unsaved edits in an editor (FA14). */
  unsaved?: (ref: KitFileRef) => boolean | Promise<boolean>
}

/** What a kit may ask for, from its manifest's `files` (K15): extensions without the dot. */
export type KitFilesManifest = { read?: string[]; create?: string[]; folders?: boolean; print?: boolean }

/** How a handle was granted (KitFiles section 3), for the grant log. */
export type KitFileGrantFlow = 'pick' | 'create' | 'list' | 'agent' | 'drop'

/** One grant, as the host records it in its session log (section 7, A10, A30) and shows it (FA16). */
export type KitFileGrant = {
  handle: string
  session: string
  kit: string
  principal: string
  flow: KitFileGrantFlow
  rights: KitFileRight[]
  kind: 'file' | 'folder'
  name: string
}

export type KitFilesOptions = {
  storage: KitFilesStorage
  /** The kit's id, and the person (or the person an agent runs for) the handles are bound to (FA1). */
  kit: string
  principal: string
  /** The kit manifest's `files` lists (K15). Absent: the kit asked for nothing, and every grant is refused. */
  manifest?: KitFilesManifest
  /** The host's picker (capability `files-pick`): answers the references the person chose, none when they cancel. */
  pick?: (params: KitFilesPickParams) => Promise<KitFileRef[]>
  /** The system's print dialog (capability `print`): answers whether the person printed. */
  print?: (job: { bytes: Uint8Array; title: string }) => Promise<boolean>
  /**
   * Whether the person just made a gesture in the kit (FA6, FA11). Default: the page's transient
   * user activation, which a click in the kit's frame gives its parent too; true where the browser
   * does not tell.
   */
  gesture?: () => boolean
  /** Caps on the bytes written per grant and per session (FA10). */
  quota?: { perGrant?: number; perSession?: number }
  /** Every grant, for the host's session log. */
  log?: (grant: KitFileGrant) => void
  /** Every `files/*` request the kit sends, before it is served (`@kition/kit-dev-host`'s `checkNoPaths`). */
  trace?: (method: string, params: unknown) => void
}

/** A `files/*` refusal: `-32000` with `error.data.reason` (KitFiles section 10). */
export function fileError(reason: KitFileErrorReason, message: string) {
  return new KitRpcError(-32000, message, { reason })
}

const badParams = (message: string) => new KitRpcError(-32602, message)

/** An ArrayBuffer from any realm: a structured clone may come from another window's. */
const isArrayBuffer = (value: unknown): value is ArrayBuffer => Object.prototype.toString.call(value) === '[object ArrayBuffer]'

/** The extension of a name, lower case, without the dot; empty when it has none. */
export function extensionOf(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A name the host may create (FA15): the last segment only, no control characters or characters
 * the platforms reserve, no leading dot, no trailing dot or space, no reserved device name
 * (`CON`, `NUL` on Windows), at most 255 characters; `Untitled` when nothing is left.
 */
export function sanitizeFileName(suggested: string) {
  const last = suggested.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  let name = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
  const dot = name.indexOf('.')
  const base = dot < 0 ? name : name.slice(0, dot)
  if (RESERVED.test(base)) name = `${base}_${name.slice(base.length)}`
  if (name.length > 255) {
    const extension = extensionOf(name)
    name = extension ? `${name.slice(0, 254 - extension.length)}.${extension}` : name.slice(0, 255)
  }
  return name || 'Untitled'
}

/** `Report.pdf`, then `Report 2.pdf`, `Report 3.pdf`, …: the first name `taken` says is free (FA7). */
export async function unusedName(name: string, taken: (candidate: string) => boolean | Promise<boolean>) {
  const dot = name.lastIndexOf('.')
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let number = 1; number < 10_000; number += 1) {
    const candidate = number === 1 ? name : `${base} ${number}${extension}`
    if (!(await taken(candidate))) return candidate
  }
  throw fileError('io-error', 'no unused name is left for this file')
}

/** A fresh handle: 128 random bits (FA1). */
function mintHandle() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return FILE_HANDLE_PREFIX + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const defaultName = (ref: KitFileRef) => ref.split(/[\\/]/).filter(Boolean).pop() ?? ref
const defaultGesture = () => (globalThis.navigator as (Navigator & { userActivation?: { isActive: boolean } }) | undefined)?.userActivation?.isActive ?? true
const normalize = (list: readonly string[] | undefined) => (list ?? []).map((item) => item.replace(/^\./, '').toLowerCase())

/** Staging in memory: the chunks, joined when the write commits, and kept when a commit fails. */
function memoryStaging(storage: KitFilesStorage, ref: () => KitFileRef, mode: () => KitFileCommitMode): KitFileStaging {
  let chunks: Uint8Array[] = []
  return {
    append: async (bytes) => void chunks.push(bytes),
    commit: async () => {
      const whole = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
      let at = 0
      for (const chunk of chunks) {
        whole.set(chunk, at)
        at += chunk.byteLength
      }
      const committed = await storage.commit(ref(), whole, mode())
      chunks = []
      return committed
    },
    abort: async () => {
      chunks = []
    },
  }
}

type Grant = KitFileGrant & {
  ref: KitFileRef
  /** Where a `create` handle's file goes (`null`: beside the document), for a name taken meanwhile. */
  folder: KitFileRef | null
  /** For a folder: the extensions its listed files may have. For a file: unused. */
  accept: string[]
  mime?: string
  version: string | null
  size?: number
  /** A `create` handle committed (FA9). */
  committed: boolean
  staging: KitFileStaging | null
  staged: number
  written: number
  /** A `replace` commit's expected version, set by the final chunk. */
  expected: string | null
}

/** One kit session's file grants and the `files/*` requests served from them. */
export type KitFileSession = {
  /** This session's id (FA1). */
  id: string
  /** The capabilities to list in `ui/initialize`: `files`, and `files-pick` and `print` when the host has them. */
  capabilities: string[]
  /**
   * Grants a handle on a file the host chose (an agent's `file` parameter, A28; a drop): the same
   * policy as the kit's own requests. A `write` grant from an agent needs `approved` (a draft beside
   * the file, or the person's explicit approval; FA13), and no session that is read-only gets one (FA17).
   * The document the agent's tool call targets is never granted here: saving it is editing it
   * (`host/write`, A7, A12), not replacing a file under FA13.
   */
  grant: (ref: KitFileRef, rights: KitFileRight[], options: { flow: 'agent' | 'drop'; approved?: boolean }) => Promise<KitFileStat>
  /** Revokes handles early (FA4, FA16) and tells the kit (`files/revoked`). */
  revoke: (handles: string[]) => Promise<void>
  /** What this session holds now (FA16). */
  grants: () => KitFileGrant[]
  /** Serves a `files/*` request from the kit. */
  serve: <M extends FilesMethod>(method: M, params: KitToHost[M][0]) => Promise<KitToHost[M][1]>
  /** The session ended (the frame closed): every handle expires and staged writes are dropped (FA4, FA9). */
  end: () => Promise<void>
}

export type FilesMethod = 'files/pick' | 'files/create' | 'files/stat' | 'files/read' | 'files/list' | 'files/write' | 'files/release' | 'files/print'
export const FILES_METHODS: FilesMethod[] = ['files/pick', 'files/create', 'files/stat', 'files/read', 'files/list', 'files/write', 'files/release', 'files/print']

/**
 * Opens one kit session's grant table. `readOnly` is the document's (UI-K7, FA17); `revoked` tells
 * the kit of handles revoked early.
 */
export function openFileSession(options: KitFilesOptions & { readOnly?: boolean; revoked?: (handles: string[]) => void }): KitFileSession {
  const { storage } = options
  const id = mintHandle().slice(FILE_HANDLE_PREFIX.length)
  const manifest = { read: normalize(options.manifest?.read), create: normalize(options.manifest?.create), folders: options.manifest?.folders === true, print: options.manifest?.print === true }
  const nameOf = storage.name ?? defaultName
  const gesture = options.gesture ?? defaultGesture
  const table = new Map<string, Grant>()
  let ended = false
  let sessionWritten = 0

  const capabilities = ['files', ...(options.pick ? ['files-pick'] : []), ...(options.print ? ['print'] : [])]

  const stat = (grant: Grant): KitFileStat => ({
    handle: grant.handle,
    name: grant.name,
    kind: grant.kind,
    ...(grant.size !== undefined ? { size: grant.size } : {}),
    ...(grant.mime !== undefined ? { mime: grant.mime } : {}),
    version: grant.version,
    rights: [...grant.rights],
  })

  const add = (ref: KitFileRef, entry: KitFileEntry | null, rights: KitFileRight[], flow: KitFileGrantFlow, extra: { accept?: string[]; name?: string; mime?: string; folder?: KitFileRef | null } = {}) => {
    const grant: Grant = {
      handle: mintHandle(),
      session: id,
      kit: options.kit,
      principal: options.principal,
      flow,
      rights,
      kind: entry?.kind ?? 'file',
      name: extra.name ?? nameOf(ref),
      ref,
      folder: extra.folder ?? null,
      accept: extra.accept ?? [],
      mime: extra.mime ?? entry?.mime,
      version: entry?.version ?? null,
      size: entry?.size,
      committed: false,
      staging: null,
      staged: 0,
      written: 0,
      expected: null,
    }
    table.set(grant.handle, grant)
    const { handle, session, kit, principal, kind, name } = grant
    options.log?.({ handle, session, kit, principal, flow, rights: [...rights], kind, name })
    return grant
  }

  /** The grant of `handle` with `right` (and of `kind`), or `file-not-granted` (FA4, FA5). */
  const granted = (handle: unknown, right?: KitFileRight, kind?: 'file' | 'folder') => {
    if (ended) throw fileError('file-not-granted', 'the session has ended')
    const grant = typeof handle === 'string' ? table.get(handle) : undefined
    if (!grant) throw fileError('file-not-granted', 'this handle was not granted to this session')
    if (right && !grant.rights.includes(right)) throw fileError('file-not-granted', `this handle has no ${right} right`)
    if (kind && grant.kind !== kind) throw fileError('file-not-granted', `this handle is not a ${kind}`)
    return grant
  }

  /** Storage failures become `io-error` with a message that names no path; refusals pass through. */
  const guarded = async <T>(run: () => Promise<T> | T): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof KitRpcError) throw error
      throw fileError('io-error', 'the host could not reach the file')
    }
  }

  const drop = async (grant: Grant) => {
    table.delete(grant.handle)
    const staging = grant.staging
    grant.staging = null
    if (staging) await staging.abort().catch(() => undefined)
  }

  const requireGesture = (what: string) => {
    if (!gesture()) throw fileError('no-gesture', `${what} needs a person's gesture in the kit`)
  }

  /** An unused name in `folder` for `suggested`, skipping names this session's uncommitted creates hold. */
  const freeRef = async (folder: KitFileRef | null, suggested: string) => {
    const reserved = new Set([...table.values()].filter((grant) => grant.rights.includes('create') && grant.kind === 'file' && !grant.committed).map((grant) => grant.ref))
    const name = await unusedName(suggested, async (candidate) => {
      const ref = storage.child(folder, candidate)
      return reserved.has(ref) || (await storage.stat(ref)) !== null
    })
    return { name, ref: storage.child(folder, name) }
  }

  const checkRead = (name: string, accept: string[] = manifest.read) => {
    const extension = extensionOf(name)
    if (!manifest.read.includes(extension) || !accept.includes(extension)) throw fileError('not-allowed', `the kit may not read .${extension || '(none)'} files`)
  }
  const checkCreate = (name: string) => {
    const extension = extensionOf(name)
    if (!manifest.create.includes(extension)) throw fileError('not-allowed', `the kit may not create .${extension || '(none)'} files`)
  }

  /** The kit's `accept`, limited to what its manifest lets it ask for: an extension outside it is refused. */
  const acceptFor = (accept: readonly string[] | undefined, allowed: string[]) => {
    const wanted = normalize(accept)
    if (wanted.some((extension) => !allowed.includes(extension))) throw fileError('not-allowed', 'the kit asked for a file type its manifest does not declare')
    return wanted.length ? wanted : allowed
  }

  const pick = async (params: KitFilesPickParams): Promise<{ files: KitFileStat[] }> => {
    if (!options.pick) throw fileError('unsupported', 'this host has no picker')
    if (params?.mode !== 'open' && params?.mode !== 'folder' && params?.mode !== 'save') throw badParams('mode is open, folder, or save')
    requireGesture('files/pick')
    if (params.mode === 'folder' && !manifest.folders) throw fileError('not-allowed', 'the kit may not ask for folders')
    const accept = acceptFor(params.accept, params.mode === 'save' ? manifest.create : manifest.read)
    if (params.mode === 'save' && params.suggestedName != null) checkCreate(sanitizeFileName(params.suggestedName))
    const chosen = await guarded(() => options.pick!(params))
    const files: KitFileStat[] = []
    for (const ref of params.mode === 'open' && !params.multiple ? chosen.slice(0, 1) : chosen) {
      const entry = await guarded(() => storage.stat(ref))
      if (params.mode === 'folder') {
        if (entry?.kind !== 'folder') continue
        // A chosen folder is read, and written into when the kit may create files (Layers to Files).
        const rights: KitFileRight[] = manifest.create.length ? ['read', 'create'] : ['read']
        files.push(stat(add(ref, entry, rights, 'pick', { accept })))
      } else if (params.mode === 'open') {
        if (entry?.kind !== 'file' || !accept.includes(extensionOf(nameOf(ref)))) continue
        files.push(stat(add(ref, entry, ['read'], 'pick')))
      } else {
        if (!accept.includes(extensionOf(nameOf(ref)))) throw fileError('not-allowed', 'the kit may not create this file type')
        if (entry?.kind === 'folder') continue
        // The person chose to replace an existing file: `write`; a new name: `create` (FA2, FA17).
        if (entry && options.readOnly) throw fileError('not-allowed', 'a read-only session replaces no file')
        files.push(stat(add(ref, entry, entry ? ['write'] : ['create'], 'pick')))
        break
      }
    }
    return { files }
  }

  const create = async (params: KitFilesCreateParams): Promise<KitFileStat> => {
    if (typeof params?.suggestedName !== 'string') throw badParams('suggestedName is a string')
    const folder = params.folder === undefined ? null : granted(params.folder, 'create', 'folder')
    const suggested = sanitizeFileName(params.suggestedName)
    checkCreate(suggested)
    const { name, ref } = await guarded(() => freeRef(folder?.ref ?? null, suggested))
    return stat(add(ref, null, ['create'], 'create', { name, folder: folder?.ref ?? null, mime: typeof params.mime === 'string' ? params.mime : undefined }))
  }

  const read = async ({ handle, offset, length }: { handle: string; offset?: number; length?: number }) => {
    const grant = granted(handle, 'read', 'file')
    const start = offset ?? 0
    if (!Number.isSafeInteger(start) || start < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) throw badParams('offset and length are whole numbers')
    const answer = await guarded(() => storage.read(grant.ref, start, length))
    grant.version = answer.version
    grant.size = answer.size
    return answer
  }

  const list = async ({ handle }: { handle: string }) => {
    const folder = granted(handle, 'read', 'folder')
    const refs = await guarded(() => storage.list(folder.ref))
    const files: KitFileStat[] = []
    for (const ref of refs) {
      if (!folder.accept.includes(extensionOf(nameOf(ref))) || !manifest.read.includes(extensionOf(nameOf(ref)))) continue
      const entry = await guarded(() => storage.stat(ref))
      if (entry?.kind !== 'file') continue
      files.push(stat(add(ref, entry, ['read'], 'list')))
    }
    return { files }
  }

  const write = async (params: KitFilesWriteParams): Promise<{ version?: string }> => {
    const grant = granted(params?.handle, undefined, 'file')
    const creating = grant.rights.includes('create')
    if (!creating && !grant.rights.includes('write')) throw fileError('file-not-granted', 'this handle has no create or write right')
    if (creating && grant.committed) throw fileError('already-committed', 'this file was already committed')
    if (!isArrayBuffer(params.bytes)) throw badParams('bytes is an ArrayBuffer')
    if (params.offset !== grant.staged) throw badParams(`offset is ${grant.staged}, the bytes staged so far`)
    const size = params.bytes.byteLength
    if ((options.quota?.perGrant !== undefined && grant.written + size > options.quota.perGrant) || (options.quota?.perSession !== undefined && sessionWritten + size > options.quota.perSession)) {
      throw fileError('quota', 'this write passes the host\'s cap')
    }
    if (params.final && !creating) {
      if (typeof params.expected !== 'string') throw fileError('conflict', 'the final chunk carries the version it replaces')
      if (await guarded(() => storage.unsaved?.(grant.ref) ?? false)) throw fileError('unsaved-edits', 'the file is open with unsaved edits')
      grant.expected = params.expected
    }
    if (!grant.staging) {
      const mode = (): KitFileCommitMode => (creating ? { mode: 'create' } : { mode: 'replace', expected: grant.expected ?? '' })
      grant.staging = storage.stage ? storage.stage(grant.ref, mode) : memoryStaging(storage, () => grant.ref, mode)
    }
    const staging = grant.staging
    await guarded(() => staging.append(new Uint8Array(params.bytes.slice(0))))
    grant.staged += size
    grant.written += size
    sessionWritten += size
    if (!params.final) return {}
    const committed = await commit(grant, staging, creating)
    grant.staging = null
    grant.staged = 0
    grant.expected = null
    grant.version = committed.version
    if (creating) grant.committed = true
    return { version: committed.version }
  }

  /**
   * Commits a staged write. A `create` whose name was taken since it was granted moves on to the
   * next unused name: it never replaces a file (FA7, H5). A name the person picked or a host
   * granted stays: its conflict stands, as with a storage that stages elsewhere (`stage`).
   */
  const commit = async (grant: Grant, staging: KitFileStaging, creating: boolean) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await guarded(() => staging.commit())
      } catch (error) {
        const conflict = error instanceof KitRpcError && (error.data as { reason?: string } | undefined)?.reason === 'conflict'
        if (!creating || !conflict || grant.flow !== 'create' || storage.stage || attempt >= 8) throw error
        const next = await guarded(() => freeRef(grant.folder, grant.name))
        grant.ref = next.ref
        grant.name = next.name
      }
    }
  }

  const release = async ({ handles }: { handles: string[] }) => {
    for (const handle of Array.isArray(handles) ? handles : []) {
      const grant = typeof handle === 'string' ? table.get(handle) : undefined
      if (grant) await drop(grant)
    }
    return {}
  }

  const print = async (params: KitFilesPrintParams): Promise<{ printed: boolean }> => {
    if (!options.print) throw fileError('unsupported', 'this host does not print')
    if (!manifest.print) throw fileError('not-allowed', 'the kit may not print')
    requireGesture('files/print')
    let bytes: Uint8Array
    // The null check stands apart so `'handle' in params` narrows both branches without strictNullChecks too.
    if (!params || typeof params !== 'object') throw badParams('a print takes PDF bytes or a handle')
    if ('handle' in params) {
      const grant = granted(params.handle, 'read', 'file')
      if (extensionOf(grant.name) !== 'pdf' && grant.mime !== 'application/pdf') throw fileError('not-allowed', 'only a PDF prints')
      bytes = await readAll(grant.ref)
    } else {
      if (params.mime !== 'application/pdf' || !isArrayBuffer(params.bytes)) throw badParams('a print takes PDF bytes or a handle')
      bytes = new Uint8Array(params.bytes.slice(0))
    }
    const title = typeof params.title === 'string' ? params.title : ''
    // Only whether the person printed: no printer names or settings (FA11).
    return { printed: (await guarded(() => options.print!({ bytes, title }))) === true }
  }

  const readAll = async (ref: KitFileRef) => {
    const parts: Uint8Array[] = []
    let at = 0
    for (;;) {
      const { bytes, size } = await guarded(() => storage.read(ref, at, undefined))
      parts.push(new Uint8Array(bytes))
      at += bytes.byteLength
      if (at >= size || bytes.byteLength === 0) break
    }
    const whole = new Uint8Array(at)
    let offset = 0
    for (const part of parts) {
      whole.set(part, offset)
      offset += part.byteLength
    }
    return whole
  }

  const served: { [M in FilesMethod]: (params: KitToHost[M][0]) => Promise<KitToHost[M][1]> } = {
    'files/pick': pick,
    'files/create': create,
    'files/stat': async ({ handle }) => {
      const grant = granted(handle)
      if (grant.rights.includes('create') && !grant.committed && grant.kind === 'file') return stat(grant)
      const entry = await guarded(() => storage.stat(grant.ref))
      if (!entry) throw fileError('file-not-granted', 'the file is gone')
      Object.assign(grant, { version: entry.version, size: entry.size, mime: entry.mime ?? grant.mime })
      return stat(grant)
    },
    'files/read': read,
    'files/list': list,
    'files/write': write,
    'files/release': release,
    'files/print': print,
  }

  return {
    id,
    capabilities,
    grant: async (ref, rights, { flow, approved }) => {
      if (ended) throw fileError('file-not-granted', 'the session has ended')
      const entry = await guarded(() => storage.stat(ref))
      const name = nameOf(ref)
      if (rights.includes('write')) {
        if (options.readOnly) throw fileError('not-allowed', 'a read-only session replaces no file')
        if (flow === 'agent' && approved !== true) throw fileError('not-allowed', 'an agent replaces a file only through a draft or the person\'s approval')
        if (entry?.kind !== 'file') throw fileError('not-allowed', 'there is no such file to replace')
        checkCreate(name)
      }
      if (rights.includes('read')) {
        if (!entry) throw fileError('not-allowed', 'there is no such file')
        if (entry.kind === 'file') checkRead(name)
        else if (!manifest.folders) throw fileError('not-allowed', 'the kit may not read folders')
      }
      if (rights.includes('create') && (!entry || entry.kind === 'file')) {
        // A file `create` grant names a new file: never one that exists (H5).
        if (entry) throw fileError('not-allowed', 'a create grant never names an existing file')
        checkCreate(name)
      }
      return stat(add(ref, entry, [...new Set(rights)], flow, entry?.kind === 'folder' ? { accept: manifest.read } : {}))
    },
    revoke: async (handles) => {
      const gone: string[] = []
      for (const handle of handles) {
        const grant = table.get(handle)
        if (!grant) continue
        await drop(grant)
        gone.push(handle)
      }
      if (gone.length) options.revoked?.(gone)
    },
    grants: () => [...table.values()].map(({ handle, session, kit, principal, flow, rights, kind, name }) => ({ handle, session, kit, principal, flow, rights: [...rights], kind, name })),
    serve: async (method, params) => {
      options.trace?.(method, params)
      if (ended) throw fileError('file-not-granted', 'the session has ended')
      return served[method](params as never) as never
    },
    end: async () => {
      ended = true
      for (const grant of [...table.values()]) await drop(grant)
    },
  }
}
