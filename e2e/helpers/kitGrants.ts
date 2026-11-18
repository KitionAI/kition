import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Page, Route } from '@playwright/test'
import { fulfillJson } from './mockApi'

type Right = 'read' | 'create' | 'write'
type Grant = { handle: string; file: string; name: string; kind: 'file' | 'folder'; rights: Right[]; flow: string; committed: boolean; staged: Buffer[] }
type Session = { kit: string; document: string | null; beside: string; readOnly: boolean; files: { read: string[]; create: string[]; folders: boolean }; grants: Map<string, Grant>; log: unknown[] }

const extensionOf = (name: string) => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '')
const id = (prefix: string) => prefix + randomBytes(16).toString('hex')
const versionOf = async (file: string) => {
  const stat = await fs.stat(file)
  return `"${Math.round(stat.mtimeMs * 1e6)}-${stat.size}"`
}

/**
 * The runtime's file grants (`/api/v1/kits/grants`, contracts/runtime/kits.schema.json) over the
 * e2e workspace at `root`, as `crates/kition-kits/src/grants.rs` serves them: sessions bound to a
 * kit and document, handles bound to their session, workspace paths that are never hidden or
 * outside, creates that never replace a file, and writes that need the version they replace.
 * Answers every grant session it saw, for specs to inspect.
 */
export async function serveKitGrants(page: Page, root: string) {
  const sessions = new Map<string, Session>()
  const refuse = (route: Route, status: number, reason: string | null, message: string) =>
    fulfillJson(route, { code: status * 100 + 10, message, data: { reason } }, status)
  const inside = (relative: string) => {
    const parts = relative.replace(/^\/+/, '').split('/')
    if (!relative || relative.includes('\\') || parts.some((part) => !part || part.startsWith('.'))) return null
    const file = path.join(root, ...parts)
    return file.startsWith(root + path.sep) ? file : null
  }
  const stat = async (grant: Grant) => {
    const exists = grant.kind === 'file' && existsSync(grant.file) && (!grant.rights.includes('create') || grant.committed)
    return {
      handle: grant.handle,
      name: grant.name,
      kind: grant.kind,
      ...(exists ? { size: (await fs.stat(grant.file)).size } : {}),
      version: exists ? await versionOf(grant.file) : null,
      rights: grant.rights,
    }
  }
  const add = async (session: Session, grant: Omit<Grant, 'handle' | 'committed' | 'staged'>) => {
    const full: Grant = { ...grant, handle: id('fh_'), committed: false, staged: [] }
    session.grants.set(full.handle, full)
    session.log.push({ at: Date.now(), event: 'grant', handle: full.handle, flow: full.flow, kit: session.kit, principal: 'user:1', rights: full.rights, kind: full.kind, name: full.name })
    return stat(full)
  }
  const unused = (folder: string, name: string) => {
    const dot = name.lastIndexOf('.')
    const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    for (let number = 1; ; number += 1) {
      const candidate = number === 1 ? name : `${base} ${number}${extension}`
      if (!existsSync(path.join(folder, candidate))) return candidate
    }
  }

  await page.route('**/api/v1/kits/grants**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const rest = url.pathname.replace(/^.*\/api\/v1\/kits\/grants/, '')
    const body = request.method() === 'POST' ? (request.postDataJSON() as Record<string, any>) : {}
    if (rest === '/sessions' && request.method() === 'POST') {
      const beside = body.document ? inside(body.document) : root
      if (!beside) return refuse(route, 403, 'not-allowed', 'this file is not available to the kit')
      const session = id('fs_')
      sessions.set(session, { kit: body.kit, document: body.document ?? null, beside: body.document ? path.dirname(beside) : root, readOnly: !!body.readOnly, files: { read: [], create: [], folders: false, ...body.files }, grants: new Map(), log: [] })
      return fulfillJson(route, { code: 200, message: 'success', data: { session } })
    }
    const sessionId = rest.startsWith('/sessions/') ? rest.slice('/sessions/'.length) : (body.session ?? url.searchParams.get('session'))
    const session = sessions.get(sessionId)
    if (!session) return refuse(route, 403, 'file-not-granted', 'this session has ended or is not yours')
    if (rest.startsWith('/sessions/')) {
      if (request.method() === 'DELETE') {
        sessions.delete(sessionId)
        return fulfillJson(route, { code: 200, message: 'success', data: { revoked: [...session.grants.keys()] } })
      }
      const grants = await Promise.all([...session.grants.values()].map(async (grant) => ({ ...(await stat(grant)), flow: grant.flow })))
      return fulfillJson(route, { code: 200, message: 'success', data: { session: sessionId, kit: session.kit, document: session.document, readOnly: session.readOnly, grants, log: session.log } })
    }
    if (rest === '') {
      const file = inside(body.path)
      const exists = !!file && existsSync(file)
      const rights = body.rights as Right[]
      if (!file || (!exists && !rights.includes('create'))) return refuse(route, 403, 'not-allowed', 'this file is not available to the kit')
      if (rights.includes('create') && exists) return refuse(route, 409, 'conflict', 'a file with this name exists; create never replaces one')
      const name = path.basename(file)
      const allowed = body.kind === 'folder' ? session.files.folders : rights.every((right) => (right === 'read' ? session.files.read : session.files.create).includes(extensionOf(name)))
      if (!allowed || (rights.includes('write') && session.readOnly)) return refuse(route, 403, 'not-allowed', 'the kit may not ask for this file')
      return fulfillJson(route, { code: 200, message: 'success', data: await add(session, { file, name, kind: body.kind, rights, flow: body.flow }) })
    }
    if (rest === '/create') {
      const folder = body.folder ? session.grants.get(body.folder) : undefined
      if (body.folder && (!folder || folder.kind !== 'folder' || !folder.rights.includes('create'))) return refuse(route, 403, 'file-not-granted', 'this handle is not a folder with a create right')
      const suggested = String(body.suggestedName).split(/[\\/]/).pop()!.replace(/^\.+/, '') || 'Untitled'
      if (!session.files.create.includes(extensionOf(suggested))) return refuse(route, 403, 'not-allowed', 'the kit may not create this file type')
      const parent = folder?.file ?? session.beside
      const name = unused(parent, suggested)
      return fulfillJson(route, { code: 200, message: 'success', data: await add(session, { file: path.join(parent, name), name, kind: 'file', rights: ['create'], flow: 'create' }) })
    }
    if (rest === '/release') {
      for (const handle of body.handles ?? []) session.grants.delete(handle)
      return fulfillJson(route, { code: 200, message: 'success', data: {} })
    }
    const [, handle, action] = /^\/([^/]+)(?:\/(list|content))?$/.exec(rest) ?? []
    const grant = handle ? session.grants.get(handle) : undefined
    if (!grant) return refuse(route, 403, 'file-not-granted', 'this handle was not granted to this session')
    if (!action) return fulfillJson(route, { code: 200, message: 'success', data: await stat(grant) })
    if (action === 'list') {
      if (grant.kind !== 'folder' || !grant.rights.includes('read')) return refuse(route, 403, 'file-not-granted', 'this handle has no read right on a folder')
      const names = (await fs.readdir(grant.file)).filter((name) => !name.startsWith('.') && session.files.read.includes(extensionOf(name))).sort()
      const files = []
      for (const name of names) files.push(await add(session, { file: path.join(grant.file, name), name, kind: 'file', rights: ['read'], flow: 'list' }))
      return fulfillJson(route, { code: 200, message: 'success', data: { files } })
    }
    if (request.method() === 'GET') {
      if (grant.kind !== 'file' || !grant.rights.includes('read')) return refuse(route, 403, 'file-not-granted', 'this handle has no read right on a file')
      const bytes = await fs.readFile(grant.file)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const length = url.searchParams.has('length') ? Number(url.searchParams.get('length')) : bytes.length
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/octet-stream', etag: await versionOf(grant.file), 'kition-file-size': String(bytes.length), 'access-control-expose-headers': 'ETag,Kition-File-Size' },
        body: bytes.subarray(offset, offset + Math.min(length, 8 << 20)),
      })
    }
    const creating = grant.rights.includes('create')
    if (!creating && !grant.rights.includes('write')) return refuse(route, 403, 'file-not-granted', 'this handle has no create or write right')
    if (creating && grant.committed) return refuse(route, 409, 'already-committed', 'this file was already committed')
    const staged = grant.staged.reduce((sum, chunk) => sum + chunk.length, 0)
    if (Number(url.searchParams.get('offset')) !== staged) return refuse(route, 400, null, `offset is ${staged}, the bytes staged so far`)
    grant.staged.push(request.postDataBuffer() ?? Buffer.alloc(0))
    if (url.searchParams.get('final') !== 'true') return fulfillJson(route, { code: 200, message: 'success', data: {} })
    const bytes = Buffer.concat(grant.staged)
    grant.staged = []
    if (creating && existsSync(grant.file)) {
      if (grant.flow !== 'create') return refuse(route, 409, 'conflict', 'a file with this name exists; create never replaces one')
      grant.name = unused(path.dirname(grant.file), grant.name)
      grant.file = path.join(path.dirname(grant.file), grant.name)
    }
    if (!creating && url.searchParams.get('expected') !== (await versionOf(grant.file))) return refuse(route, 409, 'conflict', 'the file changed since the version the kit read')
    await fs.writeFile(grant.file, bytes)
    grant.committed = creating
    session.log.push({ at: Date.now(), event: 'commit', handle: grant.handle, flow: grant.flow, kit: session.kit, principal: 'user:1', rights: grant.rights, kind: grant.kind, name: grant.name })
    return fulfillJson(route, { code: 200, message: 'success', data: { version: await versionOf(grant.file) } })
  })
  return sessions
}
