import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFile = vi.fn()
const writeFile = vi.fn()
const mkdir = vi.fn()
const rm = vi.fn()

vi.mock('node:fs/promises', () => ({
  default: {
    readFile,
    writeFile,
    mkdir,
    rm,
  },
}))

async function loadSecureStore() {
  vi.resetModules()
  return import('./secure-store.mjs')
}

describe('SecureStore', () => {
  beforeEach(() => {
    readFile.mockReset()
    writeFile.mockReset()
    mkdir.mockReset()
    rm.mockReset()
  })

  it('writes values with the plaintext tag', async () => {
    const { SecureStore } = await loadSecureStore()
    const store = new SecureStore({ data_dir: '/tmp/kition' })

    await store.set('kition.desktop.settings.v1', '{"ok":true}')

    expect(mkdir).toHaveBeenCalledWith('/tmp/kition/secrets', { recursive: true })
    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/kition/secrets/kition.desktop.settings.v1.secret',
      'plain-v1:{"ok":true}',
      'utf8',
    )
  })

  it('returns the tagged plaintext payload', async () => {
    readFile.mockResolvedValue('plain-v1:{"theme":"dark"}')

    const { SecureStore } = await loadSecureStore()
    const store = new SecureStore({ data_dir: '/tmp/kition' })

    await expect(store.get('kition.desktop.settings.v1')).resolves.toBe('{"theme":"dark"}')
  })

  it('treats legacy enc-v1 ciphertext as missing instead of touching keychain', async () => {
    readFile.mockResolvedValue('enc-v1:Y2lwaGVydGV4dA==')

    const { SecureStore } = await loadSecureStore()
    const store = new SecureStore({ data_dir: '/tmp/kition' })

    await expect(store.get('kition.desktop.settings.v1')).resolves.toBe('')
  })

  it('returns the raw body for pre-prefix legacy files', async () => {
    readFile.mockResolvedValue('{"legacy":true}')

    const { SecureStore } = await loadSecureStore()
    const store = new SecureStore({ data_dir: '/tmp/kition' })

    await expect(store.get('kition.desktop.settings.v1')).resolves.toBe('{"legacy":true}')
  })

  it('returns an empty string when the secret file does not exist', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    const { SecureStore } = await loadSecureStore()
    const store = new SecureStore({ data_dir: '/tmp/kition' })

    await expect(store.get('kition.desktop.settings.v1')).resolves.toBe('')
  })

  it('rethrows non-ENOENT read errors', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EACCES' }))

    const { SecureStore } = await loadSecureStore()
    const store = new SecureStore({ data_dir: '/tmp/kition' })

    await expect(store.get('kition.desktop.settings.v1')).rejects.toThrow('boom')
  })

  it('deletes the secret file and swallows ENOENT', async () => {
    rm.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    const { SecureStore } = await loadSecureStore()
    const store = new SecureStore({ data_dir: '/tmp/kition' })

    await store.delete('kition.desktop.settings.v1')

    expect(rm).toHaveBeenCalledWith('/tmp/kition/secrets/kition.desktop.settings.v1.secret')
  })

  it('sanitises path-traversal characters in keys', async () => {
    const { SecureStore } = await loadSecureStore()
    const store = new SecureStore({ data_dir: '/tmp/kition' })

    await store.set('../etc/passwd', 'pwn')

    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/kition/secrets/__etc_passwd.secret',
      'plain-v1:pwn',
      'utf8',
    )
  })
})
