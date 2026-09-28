import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const waitForDesktopBackendReady = vi.fn()
const getApiBaseURL = vi.fn(() => '/api')
const normalizeApiPath = vi.fn((path: string) => path)

vi.mock('@/services/desktop', () => ({
  getApiBaseURL,
  normalizeApiPath,
  waitForDesktopBackendReady,
}))

const fetchMock = vi.fn()

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } })
}

async function loadRequestModule() {
  vi.resetModules()
  return import('./request')
}

describe('request api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    waitForDesktopBackendReady.mockReset()
    waitForDesktopBackendReady.mockResolvedValue(true)
    getApiBaseURL.mockClear()
    normalizeApiPath.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('waits for the desktop backend, prefixes the base, and unwraps the envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, data: [] }))
    const mod = await loadRequestModule()

    const response = await mod.default.get('/v1/data-documents', { params: { workspace_root: '/vault', query: undefined } })

    expect(waitForDesktopBackendReady).toHaveBeenCalledTimes(1)
    expect(normalizeApiPath).toHaveBeenCalledWith('/v1/data-documents')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/data-documents?workspace_root=%2Fvault')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['X-Locale']).toBeTruthy()
    expect(response).toEqual([])
  })

  it('fails fast when the desktop backend is still unavailable', async () => {
    waitForDesktopBackendReady.mockResolvedValue(false)
    const mod = await loadRequestModule()

    await expect(mod.default.get('/v1/data-documents')).rejects.toThrow('Desktop backend is not ready yet, please retry shortly')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends JSON bodies with the content type and form data without one', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ ok: true }))
    const mod = await loadRequestModule()

    await mod.default.post('/v1/workflows', { name: 'x' })
    const [, jsonInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(jsonInit.body).toBe('{"name":"x"}')
    expect((jsonInit.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    const form = new FormData()
    form.append('file', new Blob(['a']), 'a.csv')
    await mod.default.post('/v1/imports', form)
    const [, formInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(formInit.body).toBe(form)
    expect((formInit.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('maps HTTP failures to a message and keeps the response on the error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'Table not found' }, { status: 404 }))
    const mod = await loadRequestModule()

    const failure = await mod.default.get('/v1/x').catch((error: unknown) => error as { message: string; response?: { status: number; data: unknown } })
    expect(failure.message).toBe('The requested resource was not found')
    expect(failure.response?.status).toBe(404)
    expect(failure.response?.data).toEqual({ detail: 'Table not found' })

    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'bad field' } }, { status: 400 }))
    await expect(mod.default.patch('/v1/x', {})).rejects.toThrow('bad field')
  })

  it('rejects a non-200 envelope code and reports network failures', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 500, message: 'Runtime failed' }))
    const mod = await loadRequestModule()
    await expect(mod.default.get('/v1/x')).rejects.toThrow('Runtime failed')

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(mod.default.get('/v1/x')).rejects.toThrow('Network error, please check your connection')
  })

  it('rethrows the caller abort untouched', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (init.signal?.aborted) abort()
      else init.signal?.addEventListener('abort', abort)
    }))
    const mod = await loadRequestModule()
    const pending = mod.default.get('/v1/x', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
