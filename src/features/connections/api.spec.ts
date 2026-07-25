import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@/api/request', () => ({ default: requestMock }))

import {
  CONNECTIONS_CHANGED_EVENT,
  createConnection,
  deleteConnection,
  testConnection,
  updateConnection,
  type ConnectionView,
  type SaveConnectionInput,
} from './api'

const input: SaveConnectionInput = {
  channel: 'email_smtp',
  name: '163 Mail delivery',
  settings: {
    host: 'smtp.163.com',
    port: 465,
    username: 'person@163.com',
    tlsMode: 'tls',
    from: 'person@163.com',
  },
  secrets: { password: 'authorization-code' },
}

const connection: ConnectionView = {
  id: 'conn_163',
  channel: 'email_smtp',
  name: input.name,
  settings: input.settings,
  status: 'active',
  createdAt: '2026-07-22T00:00:00Z',
  updatedAt: '2026-07-22T00:00:00Z',
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('connections API', () => {
  it('broadcasts successful connection mutations so mounted workflows refresh their options', async () => {
    const changed = vi.fn()
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, changed)
    requestMock.post.mockResolvedValueOnce(connection)
    requestMock.patch.mockResolvedValueOnce(connection)
    requestMock.delete.mockResolvedValueOnce(undefined)
    requestMock.post.mockResolvedValueOnce({ ok: true })

    await createConnection(input)
    await updateConnection(connection.id, { name: 'Updated delivery' })
    await deleteConnection(connection.id, { force: true })
    await testConnection(connection.id)

    expect(requestMock.delete).toHaveBeenCalledWith('/v1/connections/conn_163?force=true')
    expect(changed.mock.calls.map(([event]) => (event as CustomEvent).detail)).toEqual([
      { connectionId: 'conn_163', source: 'create' },
      { connectionId: 'conn_163', source: 'update' },
      { connectionId: 'conn_163', source: 'delete' },
      { connectionId: 'conn_163', source: 'test' },
    ])

    window.removeEventListener(CONNECTIONS_CHANGED_EVENT, changed)
  })

  it('does not broadcast a failed create', async () => {
    const changed = vi.fn()
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, changed)
    requestMock.post.mockRejectedValueOnce(new Error('verification failed'))

    await expect(createConnection(input)).rejects.toThrow('verification failed')
    expect(changed).not.toHaveBeenCalled()

    window.removeEventListener(CONNECTIONS_CHANGED_EVENT, changed)
  })
})
