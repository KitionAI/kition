import { beforeEach, describe, expect, it, vi } from 'vitest'

const waitForDesktopBackendReady = vi.fn()
const getApiBaseURL = vi.fn(() => '/api')
const normalizeApiPath = vi.fn((path: string) => path)

let runRequestInterceptor: ((config: any) => Promise<any>) | undefined
let runResponseInterceptor: ((response: any) => any) | undefined

const axiosInstance = {
  interceptors: {
    request: {
      use: vi.fn((fulfilled: (config: any) => Promise<any>) => {
        runRequestInterceptor = fulfilled
      }),
    },
    response: {
      use: vi.fn((fulfilled: (response: any) => any) => {
        runResponseInterceptor = fulfilled
      }),
    },
  },
  get: vi.fn(async (url: string, config?: any) => {
    const nextConfig = runRequestInterceptor ? await runRequestInterceptor({ ...(config || {}), url }) : { ...(config || {}), url }
    const response = {
      data: { code: 200, data: [] },
      status: 200,
      config: nextConfig,
    }
    return runResponseInterceptor ? runResponseInterceptor(response) : response
  }),
}

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => axiosInstance),
  },
}))

vi.mock('@/services/desktop', () => ({
  getApiBaseURL,
  normalizeApiPath,
  waitForDesktopBackendReady,
}))

async function loadRequestModule() {
  vi.resetModules()
  return import('./request')
}

describe('request api client', () => {
  beforeEach(() => {
    runRequestInterceptor = undefined
    runResponseInterceptor = undefined
    waitForDesktopBackendReady.mockReset()
    getApiBaseURL.mockClear()
    normalizeApiPath.mockClear()
    axiosInstance.get.mockClear()
  })

  it('waits for the desktop backend before sending requests', async () => {
    waitForDesktopBackendReady.mockResolvedValue(true)

    const mod = await loadRequestModule()
    const response = await mod.default.get('/v1/data-documents')

    expect(waitForDesktopBackendReady).toHaveBeenCalledTimes(1)
    expect(getApiBaseURL).toHaveBeenCalled()
    expect(normalizeApiPath).toHaveBeenCalledWith('/v1/data-documents')
    expect(axiosInstance.get).toHaveBeenCalledTimes(1)
    expect(response).toEqual([])
  })

  it('fails fast when the desktop backend is still unavailable', async () => {
    waitForDesktopBackendReady.mockResolvedValue(false)

    const mod = await loadRequestModule()

    await expect(mod.default.get('/v1/data-documents')).rejects.toThrow('Desktop backend is not ready yet, please retry shortly')
    expect(axiosInstance.get).toHaveBeenCalledTimes(1)
  })
})
