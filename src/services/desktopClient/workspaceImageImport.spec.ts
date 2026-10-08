import { afterEach, describe, expect, it, vi } from 'vitest'
import { importWorkspaceImageFromBlobURL } from './workspaceFiles'

afterEach(() => {
  window.kitionDesktop = undefined
  vi.unstubAllGlobals()
})

describe('desktop pasted image import', () => {
  it('identifies an outdated desktop preload without falling back to browser CORS', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    window.kitionDesktop = { shell: 'electron' }
    await expect(importWorkspaceImageFromBlobURL({ blobURL: 'https://example.com/image.png' }))
      .rejects.toMatchObject({ reason: 'desktopUpdate' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not report success if the workspace did not return a saved file', async () => {
    window.kitionDesktop = {
      ReadRemoteImage: vi.fn().mockResolvedValue({ mime_type: 'image/png', base64_content: 'AQID' }),
      ImportWorkspaceFile: vi.fn().mockResolvedValue({}),
    }
    await expect(importWorkspaceImageFromBlobURL({ blobURL: 'https://example.com/image.png', folder: 'attachments' }))
      .rejects.toMatchObject({ reason: 'write' })
  })
  it('uses the desktop downloader and stores its bytes without a renderer fetch', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const read = vi.fn().mockResolvedValue({ mime_type: 'image/jpeg', base64_content: 'AQID' })
    const save = vi.fn().mockResolvedValue({ imported_path: 'attachments/image.jpg' })
    window.kitionDesktop = { ReadRemoteImage: read, ImportWorkspaceFile: save }
    await expect(importWorkspaceImageFromBlobURL({ blobURL: 'https://example.com/image', folder: 'attachments' }))
      .resolves.toEqual({ importedPath: 'attachments/image.jpg', relativePath: 'attachments/image.jpg' })
    expect(read).toHaveBeenCalledWith('https://example.com/image')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ folder: 'attachments', base64_content: 'AQID', filename: expect.stringMatching(/\.jpg$/) }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects an HTML login response in the browser fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<p>Login</p>', { headers: { 'content-type': 'text/html' } })))
    await expect(importWorkspaceImageFromBlobURL({ blobURL: 'https://example.com/image' })).rejects.toThrow('not an image')
  })
})
