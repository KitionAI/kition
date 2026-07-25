import { describe, expect, it, vi } from 'vitest'

import { createBeforeQuitHandler } from './quit-lifecycle.mjs'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('desktop quit lifecycle', () => {
  it('waits for cleanup before allowing Electron to quit', async () => {
    const cleanup = deferred()
    const app = { quit: vi.fn() }
    const event = { preventDefault: vi.fn() }
    const handler = createBeforeQuitHandler({ app, cleanup: () => cleanup.promise })

    handler(event)
    handler(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(app.quit).not.toHaveBeenCalled()

    cleanup.resolve()
    await cleanup.promise
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))

    const recursiveEvent = { preventDefault: vi.fn() }
    handler(recursiveEvent)
    expect(recursiveEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('still quits after reporting a cleanup error', async () => {
    const app = { quit: vi.fn() }
    const onError = vi.fn()
    const handler = createBeforeQuitHandler({
      app,
      cleanup: async () => {
        throw new Error('cleanup failed')
      },
      onError,
    })

    handler({ preventDefault: vi.fn() })
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'cleanup failed' }))
      expect(app.quit).toHaveBeenCalledTimes(1)
    })
  })
})
