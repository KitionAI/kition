/**
 * A stand-in for the Tauri desktop shell in Playwright. It mocks Tauri's IPC
 * internals in the page, so the real `tauriBridge.ts` shim installs
 * `window.kitionDesktop`, and answers each native command from Node against a
 * temporary workspace folder. Dialogs, the clipboard, and notifications are
 * recorded instead of touching the host machine.
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'

type Args = Record<string, unknown> & { request?: Record<string, unknown> | null }
type Handler = (args: Args) => unknown | Promise<unknown>

export type DesktopHostOptions = {
  /** Workspace folder; a temporary one is created when omitted. */
  root?: string
  platform?: 'darwin' | 'win32' | 'linux'
  backendOrigin?: string
  /**
   * The launch's API token the shell's bootstrap script hands the renderer (as
   * src-tauri/src/window.rs does); the renderer then sends it to the runtime and signs file URLs
   * with it (src/services/runtimeAuth.ts). Off unless a spec sets it.
   */
  apiToken?: string
  secureValues?: Record<string, string>
  /** Replaces the built-in answer for a command. */
  overrides?: Record<string, Handler>
}

export type DesktopHost = {
  root: string
  dataDir: string
  calls: Array<{ command: string; args: Args }>
  clipboard: { html: string; text: string; imageSource: string; image: { mime_type: string; base64_content: string } | null }
  /** Answers the next save dialog with this path, or cancels with `null`. */
  saveDialogPath: string | null
  /** Files returned by the import file picker. */
  importPaths: string[]
  secureValues: Map<string, string>
  /** What `document_store_status` answers: whether this window writes the document store (its lock). */
  storeStatus: { writable: boolean; holder: { host: string; pid: number; started: number; heartbeat: number; sameHost: boolean } | null }
  emit: (event: string, payload: unknown) => Promise<void>
  dispose: () => Promise<void>
}

const editable = /\.(md|markdown|kidesign)$/i
const textual = /\.(md|markdown|kidesign|txt|csv|tsv|json|html|htm)$/i
const supported = /\.(md|markdown|ktable|kboard|kidesign|txt|csv|tsv|json|html|htm|pdf|docx|xlsx|xls|pptx|ppt|png|jpe?g|gif|webp|svg|psd|psb|kphoto|kfilm|kvector|keffect|kdesign|dxf|kcube|kfig|kslide|mp4|mov|webm|mp3|wav|m4a)$/i

function formatOf(file: string) {
  const extension = path.extname(file).toLowerCase()
  const formats: Record<string, string> = {
    '.ktable': 'table', '.kboard': 'board', '.kidesign': 'design', '.md': 'markdown', '.markdown': 'markdown',
    '.docx': 'docx', '.xlsx': 'xlsx', '.xls': 'xlsx', '.pptx': 'pptx', '.ppt': 'pptx', '.pdf': 'pdf',
    '.csv': 'csv', '.tsv': 'csv', '.json': 'json', '.txt': 'text', '.html': 'html', '.htm': 'html',
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
    '.psd': 'photo', '.psb': 'photo', '.kphoto': 'photo', '.kfilm': 'film', '.kvector': 'vector', '.keffect': 'effect', '.kdesign': 'layout', '.dxf': 'cad', '.kcube': 'cube', '.kfig': 'fig', '.kslide': 'slide',
    '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio',
  }
  return formats[extension] || 'binary'
}

function normalize(raw: unknown, allowRoot = false) {
  const value = String(raw ?? '').replace(/\\/g, '/').trim()
  if (!value) {
    if (allowRoot) return ''
    throw new Error('document path is required')
  }
  if (value.includes('\0') || path.isAbsolute(value)) throw new Error('invalid document path')
  const normalized = path.posix.normalize(value).replace(/\/$/, '')
  if (normalized === '.' && allowRoot) return ''
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error('invalid document path')
  return normalized
}

function sanitize(value: string, fallback: string) {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^\.+/, '').slice(0, 80).trim()
  return cleaned || fallback
}

async function exists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

export async function installDesktopHost(page: Page, options: DesktopHostOptions = {}): Promise<DesktopHost> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-desktop-host-'))
  const root = options.root || path.join(dataDir, 'workspace')
  await fs.mkdir(root, { recursive: true })
  const platform = options.platform || (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux')
  const backendOrigin = options.backendOrigin || 'http://127.0.0.1:18101'
  const vaults: Array<{ path: string; name: string; added_at: string; last_opened_at: string }> = [
    { path: root, name: path.basename(root), added_at: new Date().toISOString(), last_opened_at: new Date().toISOString() },
  ]
  let activeRoot = root

  const host: DesktopHost = {
    root,
    dataDir,
    calls: [],
    clipboard: { html: '', text: '', imageSource: '', image: null },
    saveDialogPath: null,
    importPaths: [],
    secureValues: new Map(Object.entries(options.secureValues || {})),
    storeStatus: { writable: true, holder: null },
    emit: async (event, payload) => {
      await page.evaluate(([name, value]) => {
        (window as unknown as { __kitionDesktopEmit?: (event: string, payload: unknown) => void })
          .__kitionDesktopEmit?.(name as string, value)
      }, [event, payload] as const)
    },
    dispose: async () => {
      // Stop the renderer first so first-run seeding cannot write during removal.
      await page.close().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }

  const resolve = (raw: unknown, allowRoot = false) => {
    const relative = normalize(raw, allowRoot)
    return { relative, absolute: relative ? path.join(activeRoot, ...relative.split('/')) : activeRoot }
  }

  async function tree(parent = ''): Promise<unknown[]> {
    const { relative, absolute } = resolve(parent, true)
    const entries = await fs.readdir(absolute, { withFileTypes: true })
    const folders: Array<[string, unknown]> = []
    const files: Array<[string, unknown]> = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const child = join(relative, entry.name)
      const stats = await fs.stat(path.join(absolute, entry.name))
      if (entry.isDirectory()) {
        folders.push([entry.name, { type: 'folder', path: child, name: entry.name, updated_at: stats.mtime.toISOString(), children: await tree(child) }])
      } else if (entry.isFile() && supported.test(entry.name)) {
        files.push([entry.name, { type: 'file', path: child, name: entry.name, format: formatOf(child), size: stats.size, updated_at: stats.mtime.toISOString() }])
      }
    }
    const byName = (left: [string, unknown], right: [string, unknown]) => left[0].localeCompare(right[0], 'en-US')
    return [...folders.sort(byName), ...files.sort(byName)].map(([, item]) => item)
  }

  const list = async () => ({ root_path: activeRoot, items: await tree() })

  async function documentResponse(relative: string, absolute: string) {
    const stats = await fs.stat(absolute)
    return {
      path: relative,
      name: path.basename(relative),
      content: textual.test(relative) ? await fs.readFile(absolute, 'utf8') : '',
      format: formatOf(relative),
      updated_at: stats.mtime.toISOString(),
      size: stats.size,
      mtime_ms: stats.mtimeMs,
    }
  }

  function checkRoot(request: Record<string, unknown>) {
    if (request.expected_root && request.expected_root !== activeRoot) throw new Error('DESIGN_WORKSPACE_CHANGED')
  }

  async function uniqueName(folder: string, requested: string, siblingFolder: boolean) {
    const extension = path.extname(requested)
    const stem = path.basename(requested, extension)
    let candidate = requested
    for (let index = 2; ; index += 1) {
      const candidateStem = path.basename(candidate, extension)
      const taken = await exists(path.join(folder, candidate)) || (siblingFolder && await exists(path.join(folder, candidateStem)))
      if (!taken) return candidate
      candidate = `${stem} ${index}${extension}`
    }
  }

  // The document replica store under `.kition/docs/`, laid out like the desktop shell's.
  const docIdPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const storeDir = () => path.join(activeRoot, '.kition', 'docs')
  const indexFile = () => path.join(storeDir(), 'index.json')
  const isIndexPath = (value: string) => {
    try {
      return normalize(value) === value
    } catch {
      return false
    }
  }
  function entryDir(docId: unknown) {
    if (typeof docId !== 'string' || !docIdPattern.test(docId)) throw new Error('invalid document id')
    return path.join(storeDir(), docId.replace(/:/g, '%3A'))
  }
  async function readIfPresent(file: string) {
    return fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  }
  async function ensureStore() {
    await fs.mkdir(storeDir(), { recursive: true })
    const gitignore = path.join(storeDir(), '.gitignore')
    if (!await exists(gitignore)) await fs.writeFile(gitignore, '*\n!.gitignore\n')
  }
  type BlobRecord = { hashes?: string[]; bundle?: string }
  type StoredCheckpoint = { id: string; time: number; origin: string; author?: string; label?: string; version?: string; seq?: number; blobs?: BlobRecord }
  /** A kit's blob bundle, `(hex SHA-256, u64 LE length, bytes) * N`, kept as one file per blob. */
  async function storeBlobs(dir: string, bundle: Buffer): Promise<BlobRecord> {
    const blobs: Array<[string, Buffer]> = []
    let at = 0
    let whole = false
    while (at < bundle.length) {
      const hash = bundle.subarray(at, at + 64).toString('latin1')
      if (at + 72 > bundle.length) { whole = true; break }
      const size = Number(bundle.readBigUInt64LE(at + 64))
      const data = bundle.subarray(at + 72, at + 72 + size)
      if (data.length !== size || sha256(data) !== hash) { whole = true; break }
      blobs.push([hash, data])
      at += 72 + size
    }
    await fs.mkdir(path.join(dir, 'blobs'), { recursive: true })
    if (whole) {
      await fs.writeFile(path.join(dir, 'blobs', sha256(bundle)), bundle)
      return { bundle: sha256(bundle) }
    }
    for (const [hash, data] of blobs) await fs.writeFile(path.join(dir, 'blobs', hash), data)
    return { hashes: blobs.map(([hash]) => hash) }
  }
  async function readBlobs(dir: string, record: BlobRecord): Promise<Buffer | null> {
    const read = async (hash: string) => {
      const data = await readIfPresent(path.join(dir, 'blobs', hash))
      return data && sha256(data) === hash ? data : null
    }
    if (record.bundle) return read(record.bundle)
    const parts: Buffer[] = []
    for (const hash of record.hashes ?? []) {
      const data = await read(hash)
      if (!data) return null
      const size = Buffer.alloc(8)
      size.writeBigUInt64LE(BigInt(data.length))
      parts.push(Buffer.from(hash, 'latin1'), size, data)
    }
    return Buffer.concat(parts)
  }
  async function readHistory(dir: string): Promise<StoredCheckpoint[]> {
    const bytes = await readIfPresent(path.join(dir, 'history.json'))
    try {
      return bytes ? (JSON.parse(bytes.toString('utf8')).checkpoints ?? []) : []
    } catch {
      return []
    }
  }
  const publicCheckpoint = ({ blobs, ...checkpoint }: StoredCheckpoint) => ({ ...checkpoint, hasBlobs: Boolean(blobs) })
  async function recordCheckpoint(dir: string, input: Record<string, unknown>, manifest: { head: { seq: number; version: string | null }; blobs?: BlobRecord } | null) {
    const history = await readHistory(dir)
    const version = typeof input.version === 'string' ? input.version : (manifest?.head.version ?? undefined)
    const last = history[history.length - 1]
    if (last && version && last.version === version) return publicCheckpoint(last)
    const checkpoint: StoredCheckpoint = {
      id: randomUUID(), time: typeof input.time === 'number' ? input.time : Date.now(), origin: String(input.origin),
      ...(typeof input.author === 'string' ? { author: input.author } : {}), ...(typeof input.label === 'string' ? { label: input.label } : {}),
      ...(version ? { version } : {}), ...(manifest ? { seq: manifest.head.seq } : {}), ...(manifest?.blobs ? { blobs: manifest.blobs } : {}),
    }
    history.push(checkpoint)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'history.json'), `${JSON.stringify({ format: 1, checkpoints: history.slice(-200) }, null, 2)}\n`)
    return publicCheckpoint(checkpoint)
  }
  async function readIndex() {
    const bytes = await readIfPresent(indexFile())
    if (!bytes) return { entries: {}, version: null }
    let stored: { entries?: Record<string, unknown> } = {}
    try {
      stored = JSON.parse(bytes.toString('utf8'))
    } catch {
      stored = {}
    }
    const entries = Object.fromEntries(Object.entries(stored.entries || {})
      .filter(([file, docId]) => isIndexPath(file) && typeof docId === 'string' && docIdPattern.test(docId)))
    return { entries, version: sha256(bytes) }
  }

  async function saveTo(defaultName: string, write: (target: string) => Promise<void>) {
    const target = host.saveDialogPath === null ? '' : host.saveDialogPath || path.join(dataDir, 'exports', defaultName)
    if (!target) return ''
    await fs.mkdir(path.dirname(target), { recursive: true })
    await write(target)
    return target
  }

  const handlers: Record<string, Handler> = {
    desktop_info: () => ({
      is_desktop: true,
      platform,
      backend_base_url: `${backendOrigin}/api`,
      data_dir: dataDir,
      cache_dir: path.join(dataDir, 'cache'),
      logs_dir: path.join(dataDir, 'logs'),
      uploads_dir: path.join(dataDir, 'uploads'),
      exports_dir: path.join(dataDir, 'exports'),
      workspace_dir: activeRoot,
      app_version: '0.0.0-e2e',
      supports_secure_storage: true,
    }),
    backend_status: () => ({ base_url: backendOrigin, health_url: '', running: true, launch_mode: 'skip_api', last_error: '', logs: '' }),
    retry_backend_start: () => handlers.backend_status({}),
    open_external_url: () => null,
    show_notification: () => null,
    window_action: () => null,
    open_runtime_path: () => null,
    bootstrap_initialize: () => ({ installation_id: 'ins_e2e', status: { official_build: false, build_channel: 'community', available: false, state: 'unavailable', installation_id: 'ins_e2e' } }),
    bootstrap_create_attestation: () => ({ status: { official_build: false, build_channel: 'community', available: false, state: 'unavailable', installation_id: 'ins_e2e' } }),
    bootstrap_status: () => ({ official_build: false, build_channel: 'community', available: false, state: 'unavailable', installation_id: 'ins_e2e' }),
    submit_feedback: () => ({ ticket_id: 'TICKET-E2E', accepted_at: new Date().toISOString() }),
    save_binary_file: ({ request }) => saveTo(String(request?.default_filename || 'export.bin'), (target) => fs.writeFile(target, Buffer.from(String(request?.base64_content || ''), 'base64'))),
    save_pdf_file: ({ request }) => saveTo(String(request?.default_filename || 'document.pdf'), (target) => fs.writeFile(target, `%PDF-1.7\n% e2e export\n${String(request?.html || '').length}\n`)),
    copy_image: ({ request }) => {
      const source = String(request?.url || '').trim()
      if (!source) throw new Error('image URL is required')
      host.clipboard = { html: '', text: '', imageSource: source, image: null }
      return true
    },
    list_workspace_documents: () => list(),
    read_workspace_image: async ({ request }) => {
      if (request?.expected_root !== activeRoot) throw new Error('DESIGN_WORKSPACE_CHANGED')
      const { absolute, relative } = resolve(request?.path)
      const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[path.extname(relative).toLowerCase()]
      if (!mime) throw new Error('Unsupported image format')
      return { mime_type: mime, base64_content: (await fs.readFile(absolute)).toString('base64') }
    },
    read_workspace_document: async ({ request }) => {
      checkRoot(request || {})
      const { relative, absolute } = resolve(request?.path)
      if (!textual.test(relative)) throw new Error('this workspace file is not text-editable')
      return documentResponse(relative, absolute)
    },
    stat_workspace_document: async ({ request }) => {
      try {
        const stats = await fs.stat(resolve(request?.path).absolute)
        return { mtime_ms: stats.mtimeMs, size: stats.size }
      } catch {
        return null
      }
    },
    write_workspace_document: async ({ request }) => {
      checkRoot(request || {})
      const { relative, absolute } = resolve(request?.path)
      if (!editable.test(relative)) throw new Error('only editable workspace documents can be saved as text')
      if (request && 'expected_content' in request && typeof request.expected_content === 'string') {
        const current = await fs.readFile(absolute, 'utf8').catch(() => null)
        if (current !== request.expected_content) throw new Error('DESIGN_SAVE_CONFLICT')
      }
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, String(request?.content ?? ''))
      return documentResponse(relative, absolute)
    },
    // The store's format 2 (src-tauri/src/workspace/docstore): `snapshot.bin`, `changes/<seq>.bin` appended after it,
    // blobs as `blobs/<sha256>`, `history.json`, and a manifest in `meta.json` naming them. Format 1 entries are read.
    read_document_store: async ({ request }) => {
      checkRoot(request || {})
      const dir = entryDir(request?.doc_id)
      const [metaBytes, snapshot] = await Promise.all(['meta.json', 'snapshot.bin'].map((name) => readIfPresent(path.join(dir, name))))
      if (!metaBytes || !snapshot) return null
      try {
        const stored = JSON.parse(metaBytes.toString('utf8'))
        if (stored?.snapshot?.sha256 !== sha256(snapshot) || stored?.meta?.docId !== request?.doc_id) return null
        if (request?.head_only) return { meta: stored.meta, seq: stored.head?.seq ?? 0, version: stored.head?.version ?? null }
        if (stored.format === 1) {
          const legacy = await readIfPresent(path.join(dir, 'blobs.bin'))
          if (stored.blobs && (!legacy || stored.blobs.sha256 !== sha256(legacy))) return null
          return { meta: stored.meta, snapshot_base64: snapshot.toString('base64'), changes_base64: [], seq: 0, version: null, complete: true, ...(legacy && stored.blobs ? { blobs_base64: legacy.toString('base64') } : {}) }
        }
        const changes: string[] = []
        for (const record of stored.changes ?? []) {
          const change = await readIfPresent(path.join(dir, 'changes', `${record.seq}.bin`))
          if (!change || sha256(change) !== record.sha256) return { meta: stored.meta, snapshot_base64: snapshot.toString('base64'), changes_base64: changes, seq: stored.snapshot.seq + changes.length, version: null, complete: false }
          changes.push(change.toString('base64'))
        }
        const blobs = stored.blobs ? await readBlobs(dir, stored.blobs) : undefined
        return {
          meta: stored.meta, snapshot_base64: snapshot.toString('base64'), changes_base64: changes, seq: stored.head.seq, version: stored.head.version ?? null,
          complete: blobs !== null, ...(blobs ? { blobs_base64: blobs.toString('base64') } : {}),
        }
      } catch {
        return null
      }
    },
    write_document_store: async ({ request }) => {
      checkRoot(request || {})
      const dir = entryDir(request?.doc_id)
      const meta = request?.meta as { docId?: unknown } | undefined
      if (!meta || meta.docId !== request?.doc_id) throw new Error('document store meta names another document')
      const metaFile = path.join(dir, 'meta.json')
      const current = await readIfPresent(metaFile).then((bytes) => (bytes ? JSON.parse(bytes.toString('utf8')) : null)).catch(() => null)
      const manifest = current?.format === 2 ? current : null
      const version = typeof request?.version === 'string' ? request.version : null
      const blobs = typeof request?.blobs_base64 === 'string' ? await storeBlobs(dir, Buffer.from(request.blobs_base64, 'base64')) : null
      await ensureStore()
      await fs.mkdir(dir, { recursive: true })
      let next: Record<string, unknown> & { head: { seq: number; version: string | null }; changes: Array<{ seq: number }> }
      if (typeof request?.changes_base64 === 'string') {
        if (!manifest || manifest.head.seq !== request.base_seq) throw new Error('DOCUMENT_STORE_CONFLICT')
        const change = Buffer.from(request.changes_base64, 'base64')
        const seq = manifest.head.seq + 1
        await fs.mkdir(path.join(dir, 'changes'), { recursive: true })
        await fs.writeFile(path.join(dir, 'changes', `${seq}.bin`), change)
        next = { ...manifest, meta, changes: [...manifest.changes, { seq, sha256: sha256(change), size: change.length }], head: { seq, version }, ...(blobs ? { blobs } : {}) }
      } else {
        const snapshot = Buffer.from(String(request?.snapshot_base64 ?? ''), 'base64')
        const seq = (manifest?.head.seq ?? 0) + 1
        await fs.writeFile(path.join(dir, 'snapshot.bin'), snapshot)
        await fs.rm(path.join(dir, 'changes'), { recursive: true, force: true })
        await fs.rm(path.join(dir, 'blobs.bin'), { force: true })
        next = { format: 2, meta, snapshot: { sha256: sha256(snapshot), size: snapshot.length, seq }, changes: [], head: { seq, version }, ...(blobs ? { blobs } : {}) }
        if (request?.lineage === 'new') await fs.rm(path.join(dir, 'history.json'), { force: true })
      }
      await fs.writeFile(metaFile, `${JSON.stringify(next, null, 2)}\n`)
      const written: Record<string, unknown> = { seq: next.head.seq, version: next.head.version, compact: next.changes.length >= 64 }
      if (request?.checkpoint) written.checkpoint = await recordCheckpoint(dir, request.checkpoint as Record<string, unknown>, next)
      return written
    },
    read_document_history: async ({ request }) => {
      checkRoot(request || {})
      const history = await readHistory(entryDir(request?.doc_id))
      return { checkpoints: history.map(publicCheckpoint).reverse() }
    },
    record_document_checkpoint: async ({ request }) => {
      checkRoot(request || {})
      const dir = entryDir(request?.doc_id)
      const checkpoint = request?.checkpoint as Record<string, unknown> | undefined
      if (!checkpoint || typeof checkpoint.origin !== 'string') throw new Error('a checkpoint needs an origin')
      const manifest = await readIfPresent(path.join(dir, 'meta.json')).then((bytes) => (bytes ? JSON.parse(bytes.toString('utf8')) : null)).catch(() => null)
      await ensureStore()
      return { checkpoint: await recordCheckpoint(dir, checkpoint, manifest?.format === 2 ? manifest : null) }
    },
    read_document_checkpoint: async ({ request }) => {
      checkRoot(request || {})
      const dir = entryDir(request?.doc_id)
      const found = (await readHistory(dir)).find((checkpoint) => checkpoint.id === request?.id)
      if (!found) return null
      const blobs = found.blobs ? await readBlobs(dir, found.blobs) : null
      return { checkpoint: publicCheckpoint(found), ...(blobs ? { blobs_base64: blobs.toString('base64') } : {}) }
    },
    document_store_status: async () => host.storeStatus,
    delete_document_store: async ({ request }) => {
      checkRoot(request || {})
      await fs.rm(entryDir(request?.doc_id), { recursive: true, force: true })
      return null
    },
    read_document_index: async ({ request }) => {
      checkRoot(request || {})
      return readIndex()
    },
    write_document_index: async ({ request }) => {
      checkRoot(request || {})
      const entries = (request?.entries || {}) as Record<string, unknown>
      for (const [file, docId] of Object.entries(entries)) {
        if (!isIndexPath(file)) throw new Error('invalid document path in the document index')
        if (typeof docId !== 'string' || !docIdPattern.test(docId)) throw new Error('invalid document id')
      }
      if ((await readIndex()).version !== (request?.expected_version ?? null)) throw new Error('DOCUMENT_INDEX_CONFLICT')
      const bytes = Buffer.from(`${JSON.stringify({ format: 1, entries }, null, 2)}\n`)
      await ensureStore()
      await fs.writeFile(indexFile(), bytes)
      return { version: sha256(bytes) }
    },
    create_workspace_document: async ({ request }) => {
      const folder = normalize(request?.folder, true)
      const folderPath = resolve(folder, true).absolute
      await fs.mkdir(folderPath, { recursive: true })
      const base = sanitize(String(request?.title || ''), 'Untitled note').replace(/\.md$/i, '')
      const name = await uniqueName(folderPath, `${base}.md`, true)
      const absolute = path.join(folderPath, name)
      await fs.writeFile(absolute, '')
      return documentResponse(join(folder, name), absolute)
    },
    create_workspace_folder: async ({ request }) => {
      const parent = normalize(request?.parent_folder, true)
      const parentPath = resolve(parent, true).absolute
      await fs.mkdir(parentPath, { recursive: true })
      const name = await uniqueName(parentPath, sanitize(String(request?.name || ''), 'Untitled folder'), false)
      await fs.mkdir(path.join(parentPath, name), { recursive: true })
      return { ...(await list()), created_path: join(parent, name) }
    },
    move_workspace_document: async ({ request }) => {
      const source = resolve(request?.path)
      const sourceParent = path.posix.dirname(source.relative) === '.' ? '' : path.posix.dirname(source.relative)
      const targetFolder = request && 'target_folder' in request ? normalize(request.target_folder, true) : sourceParent
      const requested = String(request?.target_name || '').trim() || path.basename(source.relative)
      if (targetFolder === sourceParent && requested === path.basename(source.relative)) return documentResponse(source.relative, source.absolute)
      const targetFolderPath = resolve(targetFolder, true).absolute
      await fs.mkdir(targetFolderPath, { recursive: true })
      const name = await uniqueName(targetFolderPath, requested, true)
      const target = path.join(targetFolderPath, name)
      await fs.rename(source.absolute, target)
      const sourceChild = path.join(path.dirname(source.absolute), path.basename(source.relative, path.extname(source.relative)))
      const targetChild = path.join(targetFolderPath, path.basename(name, path.extname(name)))
      if (sourceChild !== targetChild && await exists(sourceChild)) await fs.rename(sourceChild, targetChild)
      return documentResponse(join(targetFolder, name), target)
    },
    move_workspace_folder: async ({ request }) => {
      const source = resolve(request?.path, true)
      if (!source.relative) throw new Error('root folder cannot be moved')
      const sourceParent = path.posix.dirname(source.relative) === '.' ? '' : path.posix.dirname(source.relative)
      const targetFolder = request && 'target_folder' in request ? normalize(request.target_folder, true) : sourceParent
      const requested = String(request?.target_name || '').trim() || path.basename(source.relative)
      const targetRelative = join(targetFolder, requested)
      if (targetRelative === source.relative || targetRelative.startsWith(`${source.relative}/`)) throw new Error('folder cannot be moved into itself')
      const targetFolderPath = resolve(targetFolder, true).absolute
      await fs.mkdir(targetFolderPath, { recursive: true })
      const name = await uniqueName(targetFolderPath, requested, false)
      await fs.rename(source.absolute, path.join(targetFolderPath, name))
      return { ...(await list()), moved_path: join(targetFolder, name) }
    },
    delete_workspace_document: async ({ request }) => {
      const source = resolve(request?.path)
      await fs.rm(source.absolute)
      await fs.rm(path.join(path.dirname(source.absolute), path.basename(source.relative, path.extname(source.relative))), { recursive: true, force: true })
      return list()
    },
    delete_workspace_folder: async ({ request }) => {
      const source = resolve(request?.path)
      await fs.rm(source.absolute, { recursive: true })
      return list()
    },
    open_workspace_file: () => '',
    reveal_workspace_folder: () => '',
    import_workspace_file: async ({ request }) => {
      checkRoot(request || {})
      const folder = String(request?.folder || '').trim()
      const raw = String(request?.filename || '').trim()
      const extension = path.extname(raw)
      const requested = `${sanitize(path.basename(raw, extension), `imported-file-${Date.now()}`)}${extension}`
      if (!supported.test(requested)) throw new Error('unsupported workspace file type')
      const folderPath = resolve(folder, true).absolute
      await fs.mkdir(folderPath, { recursive: true })
      const name = await uniqueName(folderPath, requested, false)
      const bytes = request?.source_path
        ? await fs.readFile(String(request.source_path))
        : Buffer.from(String(request?.base64_content || ''), 'base64')
      if (!request?.source_path && !request?.base64_content) throw new Error('missing source_path or base64_content')
      await fs.writeFile(path.join(folderPath, name), bytes)
      return { ...(await list()), imported_path: join(folder, name) }
    },
    choose_files_to_import: () => ({ canceled: host.importPaths.length === 0, paths: host.importPaths }),
    choose_workspace_folder: () => null,
    set_workspace_folder: async ({ request }) => {
      activeRoot = String(request?.path || '').trim()
      if (!activeRoot) throw new Error('workspace path is required')
      return list()
    },
    list_vaults: () => ({ vaults, active_vault_path: activeRoot }),
    add_vault: async ({ request }) => {
      const vaultPath = String(request?.path || '') || path.join(String(request?.parent_path || ''), String(request?.name || 'Workspace'))
      await fs.mkdir(vaultPath, { recursive: true })
      const vault = { path: vaultPath, name: String(request?.name || '') || path.basename(vaultPath), added_at: new Date().toISOString(), last_opened_at: '' }
      if (!vaults.some((item) => item.path === vaultPath)) vaults.push(vault)
      return { vault, registry: { vaults, active_vault_path: activeRoot } }
    },
    remove_vault: ({ request }) => {
      const index = vaults.findIndex((item) => item.path === request?.path)
      if (index >= 0) vaults.splice(index, 1)
      return { vaults, active_vault_path: activeRoot }
    },
    rename_vault: ({ request }) => {
      const vault = vaults.find((item) => item.path === request?.path)
      if (!vault) throw new Error('vault not found in registry')
      vault.name = String(request?.name || '').trim() || vault.name
      return { vault, registry: { vaults, active_vault_path: activeRoot } }
    },
    set_active_vault: async ({ request }) => {
      activeRoot = String(request?.path || '').trim()
      return { list: await list(), registry: { vaults, active_vault_path: activeRoot } }
    },
    choose_directory: () => ({ canceled: true, path: '' }),
    open_workspace_window: () => ({ opened: true }),
    choose_agent_analysis_directory: () => null,
    store_secure_value: ({ key, value }) => {
      host.secureValues.set(String(key), String(value))
      return null
    },
    read_secure_value: ({ key }) => host.secureValues.get(String(key)) ?? '',
    delete_secure_value: ({ key }) => {
      host.secureValues.delete(String(key))
      return null
    },
    updates_get_state: () => ({ phase: 'unsupported', reason: 'dev build' }),
    updates_check: () => ({ phase: 'unsupported', reason: 'dev build' }),
    updates_download: () => null,
    updates_install: () => null,
    updates_set_beta_channel: () => null,
    updates_set_auto_check: () => null,
    proxy_get: () => ({ enabled: false, scheme: 'http', host: '', port: 0, username: '', noProxy: 'localhost, 127.0.0.1, ::1', hasPassword: false }),
    proxy_save: ({ payload }) => ({ state: { ...(payload as object), hasPassword: false }, requiresRestart: false }),
    proxy_test: () => ({ ok: false, message: 'host or port not set' }),
    proxy_restart_backend: () => ({ ok: true }),
    ...options.overrides,
  }

  await page.exposeBinding('__kitionDesktopInvoke', async (_source, command: string, args: Args) => {
    host.calls.push({ command, args })
    const handler = handlers[command]
    if (!handler) throw new Error(`command ${command} not found`)
    return handler(args || {})
  })

  await page.addInitScript(({ platform: hostPlatform, backendOrigin: origin, apiToken }) => {
    // The token goes to the main frame only, like Tauri's `initialization_script`.
    if (apiToken && window.top === window) Object.defineProperty(window, '__KITION_API_TOKEN__', { value: apiToken, configurable: true, enumerable: false, writable: false })
    type Callback = (payload: unknown) => void
    const callbacks = new Map<number, Callback>()
    const listeners = new Map<string, number[]>()
    const target = window as unknown as Record<string, unknown>
    target.__KITION_DESKTOP__ = Object.freeze({ shell: 'tauri', backendOrigin: origin, platform: hostPlatform })
    target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (event: string, id: number) => {
        listeners.set(event, (listeners.get(event) || []).filter((item) => item !== id))
      },
    }
    target.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: (callback: Callback, once = false) => {
        const id = window.crypto.getRandomValues(new Uint32Array(1))[0]
        callbacks.set(id, (payload) => {
          if (once) callbacks.delete(id)
          callback(payload)
        })
        return id
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (filePath: string) => filePath,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'plugin:event|listen') {
          const event = String(args.event)
          listeners.set(event, [...(listeners.get(event) || []), Number(args.handler)])
          return args.handler
        }
        if (command === 'plugin:event|unlisten') return null
        if (command.startsWith('plugin:window|')) return null
        const invokeHost = (window as unknown as { __kitionDesktopInvoke: (command: string, args: unknown) => Promise<unknown> }).__kitionDesktopInvoke
        return invokeHost(command, args)
      },
    }
    target.__kitionDesktopEmit = (event: string, payload: unknown) => {
      for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, id, payload })
    }
  }, { platform, backendOrigin, apiToken: options.apiToken || '' })

  return host
}

