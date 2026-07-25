import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { notify } from './notify'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    promise: vi.fn((p) => p),
  }),
}))

const mocked = toast as unknown as {
  success: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  warning: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  loading: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
  promise: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('notify basic variants', () => {
  it('success forwards message to sonner', () => {
    notify.success('saved')
    expect(mocked.success).toHaveBeenCalledWith('saved', expect.any(Object))
  })

  it('error defaults to 6000ms duration', () => {
    notify.error('boom')
    expect(mocked.error).toHaveBeenCalledWith('boom', expect.objectContaining({ duration: 6000 }))
  })

  it('success defaults to 4000ms duration', () => {
    notify.success('ok')
    expect(mocked.success).toHaveBeenCalledWith('ok', expect.objectContaining({ duration: 4000 }))
  })

  it('explicit duration overrides default', () => {
    notify.error('boom', { duration: 1000 })
    expect(mocked.error).toHaveBeenCalledWith('boom', expect.objectContaining({ duration: 1000 }))
  })

  it('dismiss forwards id', () => {
    notify.dismiss('x')
    expect(mocked.dismiss).toHaveBeenCalledWith('x')
  })

  it('dismiss without id closes all', () => {
    notify.dismiss()
    expect(mocked.dismiss).toHaveBeenCalledWith(undefined)
  })
})

describe('persistentError', () => {
  it('forces Infinity duration', () => {
    notify.persistentError('save failed', { label: 'Retry', onClick: () => {} })
    expect(mocked.error).toHaveBeenCalledWith(
      'save failed',
      expect.objectContaining({ duration: Number.POSITIVE_INFINITY }),
    )
  })

  it('attaches action', () => {
    const onClick = vi.fn()
    notify.persistentError('save failed', { label: 'Retry', onClick })
    const call = mocked.error.mock.calls[0]
    expect(call[1].action).toEqual({ label: 'Retry', onClick })
  })

  it('passes through id for dedup', () => {
    notify.persistentError('save failed', { label: 'Retry', onClick: () => {} }, { id: 'doc-autosave:42' })
    expect(mocked.error).toHaveBeenCalledWith(
      'save failed',
      expect.objectContaining({ id: 'doc-autosave:42' }),
    )
  })
})

describe('promise wrapper', () => {
  it('forwards promise + messages to sonner', async () => {
    const p = Promise.resolve('hello')
    await notify.promise(p, { loading: 'L', success: 'S', error: 'E' })
    expect(mocked.promise).toHaveBeenCalled()
    const call = mocked.promise.mock.calls[0]
    expect(call[0]).toBe(p)
    expect(call[1]).toMatchObject({ loading: 'L', success: 'S', error: 'E' })
  })

  it('returns the original promise (so callers can await it)', async () => {
    const sentinel = Promise.resolve('SENTINEL')
    mocked.promise.mockImplementationOnce(() => sentinel)
    const p = Promise.resolve(7)
    const ret = notify.promise(p, { loading: 'L', success: 'S', error: 'E' })
    expect(ret).toBe(p)
    expect(ret).not.toBe(sentinel)
    await expect(ret).resolves.toBe(7)
  })
})
