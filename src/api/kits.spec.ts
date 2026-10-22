import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('./request', () => ({ default: requestMock }))
vi.mock('@/services/desktop', () => ({ resolveApiURL: (path: string) => `/api${path}` }))

import { expectMatchesContract } from '@/test/contracts'
import {
  createKitFile,
  endKitFileSession,
  grantKitFile,
  kitFileSession,
  listKitFolder,
  openKitFileSession,
  readKitFile,
  releaseKitFiles,
  statKitFile,
  writeKitFileChunk,
} from './kits'

const session = 'fs_0123456789abcdef0123456789abcdef'
const handle = 'fh_fedcba9876543210fedcba9876543210'
const stat = { handle, name: 'photo.png', kind: 'file', size: 10, version: '"1-10"', rights: ['read'] }

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('kit file grants client', () => {
  it('opens, shows, and ends a grant session', async () => {
    const opened = { kit: 'kit.pdf', document: 'docs/report.pdf', files: { read: ['pdf'], create: ['pdf'], folders: true }, readOnly: false }
    expectMatchesContract(opened, 'kits', 'grantSessionRequest')
    requestMock.post.mockResolvedValueOnce({ session })
    await expect(openKitFileSession(opened)).resolves.toBe(session)
    expect(requestMock.post).toHaveBeenCalledWith('/v1/kits/grants/sessions', opened, expect.objectContaining({ suppressErrorMessage: true }))

    const view = { session, kit: 'kit.pdf', document: 'docs/report.pdf', readOnly: false, grants: [{ ...stat, flow: 'pick' }], log: [] }
    expectMatchesContract(view, 'kits', 'grantSessionView')
    requestMock.get.mockResolvedValueOnce(view)
    await expect(kitFileSession(session)).resolves.toEqual(view)
    expect(requestMock.get).toHaveBeenCalledWith(`/v1/kits/grants/sessions/${session}`, expect.anything())

    requestMock.delete.mockResolvedValueOnce({ revoked: [handle] })
    await expect(endKitFileSession(session)).resolves.toEqual([handle])
  })

  it('grants, creates, stats, lists, and releases handles', async () => {
    const picked = { session, path: 'art/photo.png', kind: 'file' as const, rights: ['read' as const], flow: 'pick' as const }
    expectMatchesContract(picked, 'kits', 'grantRequest')
    expectMatchesContract(stat, 'kits', 'fileStat')
    requestMock.post.mockResolvedValueOnce(stat)
    await expect(grantKitFile(picked)).resolves.toEqual(stat)
    expect(requestMock.post).toHaveBeenLastCalledWith('/v1/kits/grants', picked, expect.anything())

    const created = { session, suggestedName: 'Report.pdf', mime: 'application/pdf' }
    expectMatchesContract(created, 'kits', 'createFileRequest')
    requestMock.post.mockResolvedValueOnce({ ...stat, version: null, rights: ['create'] })
    await createKitFile(created)
    expect(requestMock.post).toHaveBeenLastCalledWith('/v1/kits/grants/create', created, expect.anything())

    requestMock.get.mockResolvedValueOnce(stat)
    await statKitFile(session, handle)
    expect(requestMock.get).toHaveBeenLastCalledWith(`/v1/kits/grants/${handle}`, expect.objectContaining({ params: { session } }))

    requestMock.get.mockResolvedValueOnce({ files: [stat] })
    await expect(listKitFolder(session, handle)).resolves.toEqual([stat])
    expect(requestMock.get).toHaveBeenLastCalledWith(`/v1/kits/grants/${handle}/list`, expect.objectContaining({ params: { session } }))

    requestMock.post.mockResolvedValueOnce({})
    await releaseKitFiles(session, [handle])
    expectMatchesContract({ session, handles: [handle] }, 'kits', 'releaseRequest')
    expect(requestMock.post).toHaveBeenLastCalledWith('/v1/kits/grants/release', { session, handles: [handle] }, expect.anything())
  })

  it('reads bytes with their version and size, and passes refusals on', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([2, 3, 4]), { status: 200, headers: { ETag: '"1-10"', 'Kition-File-Size': '10' } }))
    vi.stubGlobal('fetch', fetchMock)
    const read = await readKitFile(session, handle, { offset: 2, length: 3 })
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/kits/grants/${handle}/content?session=${session}&offset=2&length=3`, expect.objectContaining({ headers: expect.any(Headers) }))
    expectMatchesContract({ session, offset: 2, length: 3 }, 'kits', 'readFileQuery')
    expect(new Uint8Array(read.bytes)).toEqual(new Uint8Array([2, 3, 4]))
    expect(read).toMatchObject({ version: '"1-10"', size: 10 })

    const refusal = { code: 40310, message: 'this handle was not granted to this session', data: { reason: 'file-not-granted' } }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(refusal), { status: 403, headers: { 'content-type': 'application/json' } }))
    await expect(readKitFile(session, handle)).rejects.toMatchObject({ message: refusal.message, response: { status: 403, data: refusal } })
  })

  it('writes chunks as raw bytes, the final one with the version it replaces', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    requestMock.put.mockResolvedValueOnce({})
    await writeKitFileChunk(session, handle, bytes, { offset: 0 })
    expect(requestMock.put).toHaveBeenLastCalledWith(
      `/v1/kits/grants/${handle}/content`,
      bytes,
      expect.objectContaining({ params: { session, offset: 0, final: undefined, expected: undefined }, headers: { 'Content-Type': 'application/octet-stream' } }),
    )
    requestMock.put.mockResolvedValueOnce({ version: '"2-6"' })
    await expect(writeKitFileChunk(session, handle, bytes, { offset: 3, final: true, expected: '"1-10"' })).resolves.toEqual({ version: '"2-6"' })
    expectMatchesContract({ session, offset: 3, final: true, expected: '"1-10"' }, 'kits', 'writeChunkQuery')
    expectMatchesContract({ version: '"2-6"' }, 'kits', 'writeChunkResult')
  })
})
