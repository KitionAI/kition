import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWorkspaceWatcher } from './workspace-watcher.mjs'

function makeFakeChokidar() {
  const handlers = {}
  return {
    api: {
      watch: vi.fn(() => ({
        on(name, cb) { handlers[name] = cb; return this },
        close: vi.fn(() => Promise.resolve()),
      })),
    },
    emit(name, ...args) { handlers[name]?.(...args) },
  }
}

describe('createWorkspaceWatcher', () => {
  let now
  beforeEach(() => { now = 1_000_000 })
  afterEach(() => { vi.useRealTimers() })

  it('suppresses change events for paths within the self-write window', async () => {
    const fake = makeFakeChokidar()
    const onEvent = vi.fn()
    const watcher = await createWorkspaceWatcher({
      rootPath: '/vault',
      onEvent,
      chokidar: fake.api,
      now: () => now,
    })
    fake.emit('ready')

    watcher.markSelfWrite('/vault/foo.md', 800)
    fake.emit('change', '/vault/foo.md', { mtimeMs: 123 })

    // Self-write swallowed
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('forwards change events after the self-write window expires', async () => {
    const fake = makeFakeChokidar()
    const onEvent = vi.fn()
    const watcher = await createWorkspaceWatcher({
      rootPath: '/vault',
      onEvent,
      chokidar: fake.api,
      now: () => now,
    })
    fake.emit('ready')

    watcher.markSelfWrite('/vault/foo.md', 800)
    now += 1_000 // past the 800ms window
    fake.emit('change', '/vault/foo.md', { mtimeMs: 123 })

    // Wait for debounce to drain
    await new Promise((r) => setTimeout(r, 150))
    expect(onEvent).toHaveBeenCalledWith({
      path: '/vault/foo.md',
      eventType: 'change',
      mtimeMs: 123,
    })
  })

  it('coalesces rapid same-path events via debounce', async () => {
    const fake = makeFakeChokidar()
    const onEvent = vi.fn()
    await createWorkspaceWatcher({
      rootPath: '/vault',
      onEvent,
      chokidar: fake.api,
      now: () => now,
      debounceMs: 50,
    })
    fake.emit('ready')

    fake.emit('change', '/vault/foo.md', { mtimeMs: 1 })
    fake.emit('change', '/vault/foo.md', { mtimeMs: 2 })
    fake.emit('change', '/vault/foo.md', { mtimeMs: 3 })

    await new Promise((r) => setTimeout(r, 100))
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({
      path: '/vault/foo.md',
      eventType: 'change',
      mtimeMs: 3,
    })
  })

  it('ignores events before ready', async () => {
    const fake = makeFakeChokidar()
    const onEvent = vi.fn()
    await createWorkspaceWatcher({
      rootPath: '/vault',
      onEvent,
      chokidar: fake.api,
      now: () => now,
    })

    fake.emit('change', '/vault/foo.md', { mtimeMs: 1 })
    await new Promise((r) => setTimeout(r, 150))
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('passes ignored globs to chokidar.watch', async () => {
    const fake = makeFakeChokidar()
    await createWorkspaceWatcher({
      rootPath: '/vault',
      onEvent: vi.fn(),
      chokidar: fake.api,
      now: () => now,
    })
    expect(fake.api.watch).toHaveBeenCalledWith('/vault', expect.objectContaining({
      ignored: expect.arrayContaining(['**/.git/**', '**/node_modules/**', '**/.DS_Store']),
    }))
  })
})
