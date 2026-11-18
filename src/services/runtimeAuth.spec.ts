import { afterEach, describe, expect, it, vi } from 'vitest'

const TOKEN_PROPERTY = '__KITION_API_TOKEN__'
const target = window as unknown as Record<string, unknown>

async function loadWithDesktopToken(token: string | undefined, backendOrigin = 'http://127.0.0.1:18101') {
  vi.resetModules()
  if (token !== undefined) {
    Object.defineProperty(window, TOKEN_PROPERTY, { value: token, configurable: true, enumerable: false, writable: false })
  }
  window.kitionDesktop = { shell: 'tauri', backendOrigin } as typeof window.kitionDesktop
  return import('./runtimeAuth')
}

afterEach(() => {
  delete target[TOKEN_PROPERTY]
  delete (window as { kitionDesktop?: unknown }).kitionDesktop
  vi.unstubAllGlobals()
})

describe('runtimeAuth', () => {
  it('takes the token off window as it loads, so nothing that runs later finds it', async () => {
    const auth = await loadWithDesktopToken('launch-token')
    expect(auth.hasRuntimeToken()).toBe(true)
    expect(TOKEN_PROPERTY in window).toBe(false)
    expect(JSON.stringify(Object.getOwnPropertyNames(window).filter((name) => name.includes('TOKEN')))).toBe('[]')
    expect(JSON.stringify(window.kitionDesktop)).not.toContain('launch-token')
  })

  it('sends the token to the runtime only', async () => {
    const auth = await loadWithDesktopToken('launch-token')
    expect(auth.runtimeTokenHeaders('http://127.0.0.1:18101/api/v1/desktop/hooks')).toEqual({ 'Kition-Token': 'launch-token' })
    for (const elsewhere of ['https://kition.ai/api/x', 'http://127.0.0.1:18102/api/v1/x', 'http://localhost:18101/api/v1/x', '/api/v1/x']) {
      expect(auth.runtimeTokenHeaders(elsewhere), elsewhere).toEqual({})
    }
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await auth.runtimeFetch('http://127.0.0.1:18101/api/v1/x', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    await auth.runtimeFetch('https://example.com/x')
    const [[, sent], [, other]] = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(new Headers(sent.headers).get('kition-token')).toBe('launch-token')
    expect(new Headers(sent.headers).get('content-type')).toBe('application/json')
    expect(new Headers(other.headers).has('kition-token')).toBe(false)
  })

  it('signs file and folder paths as the runtime checks them, never with the token in the URL', async () => {
    const auth = await loadWithDesktopToken('test-token')
    const now = (4_102_444_800 - 25 * 3600) * 1000
    // The runtime's own example (crates/kition-http/src/gate.rs).
    expect(auth.signRuntimePath('/kit-files/', { scope: 'folder', now })).toBe(
      '/_signed/4102444800.11.38171d08275ed2553e0d9f40dfd420d46ee6117cb075fb48a5b4e0c8e7e75d3a/kit-files/',
    )
    const file = auth.signRuntimePath('/workspace-files/art/cover%20one.png?v=2#x', { now })
    expect(file).toMatch(/^\/_signed\/4102444800\.36\.[0-9a-f]{64}\/workspace-files\/art\/cover%20one\.png\?v=2#x$/)
    expect(file).not.toContain('test-token')
    // Stable within the hour, so an image does not reload.
    expect(auth.signRuntimePath('/uploads/a.png', { now: now + 59 * 60 * 1000 })).toBe(auth.signRuntimePath('/uploads/a.png', { now }))
    expect(auth.signRuntimeURL('http://127.0.0.1:18101/api/v1/kits/bridge', { now })).toMatch(/^http:\/\/127\.0\.0\.1:18101\/_signed\/4102444800\.19\.[0-9a-f]{64}\/api\/v1\/kits\/bridge$/)
    // Other origins, and folders that do not end in `/`, are left as they are.
    expect(auth.signRuntimeURL('https://example.com/workspace-files/a.png')).toBe('https://example.com/workspace-files/a.png')
    expect(auth.signRuntimePath('/kit-files', { scope: 'folder' })).toBe('/kit-files')
  })

  it('leaves URLs and headers alone without a token (the web build)', async () => {
    const auth = await loadWithDesktopToken(undefined, '')
    expect(auth.hasRuntimeToken()).toBe(false)
    expect(auth.signRuntimePath('/workspace-files/a.png')).toBe('/workspace-files/a.png')
    expect(auth.runtimeTokenHeaders('/api/v1/x')).toEqual({})
  })
})
