import path from 'node:path'

const DEFAULT_SELF_WRITE_MS = 800
const DEFAULT_DEBOUNCE_MS = 100

const IGNORED_GLOBS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.kition/**',
  '**/.DS_Store',
  '**/*.tmp',
  '**/*~',
]

export async function createWorkspaceWatcher({
  rootPath,
  onEvent,
  chokidar,
  log = console,
  now = () => Date.now(),
  selfWriteMs = DEFAULT_SELF_WRITE_MS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
  const selfWrites = new Map() // path → expiresAtMs
  const debounceTimers = new Map() // path → { timer, pending }
  let ready = false

  function isSelfWrite(p) {
    const expires = selfWrites.get(p)
    if (expires === undefined) return false
    if (now() > expires) {
      selfWrites.delete(p)
      return false
    }
    return true
  }

  function scheduleEmit(p, eventType, stats) {
    const existing = debounceTimers.get(p)
    if (existing) clearTimeout(existing.timer)
    const pending = { eventType, mtimeMs: stats?.mtimeMs }
    const timer = setTimeout(() => {
      debounceTimers.delete(p)
      try {
        onEvent({ path: p, eventType: pending.eventType, mtimeMs: pending.mtimeMs })
      } catch (err) {
        log.warn?.('workspace-watcher onEvent threw:', err)
      }
    }, debounceMs)
    debounceTimers.set(p, { timer, pending })
  }

  function handleRawEvent(eventType, raw, stats) {
    if (!ready) return
    if (!raw) return
    const absolute = path.isAbsolute(raw) ? raw : path.join(rootPath, raw)
    if (isSelfWrite(absolute)) return
    scheduleEmit(absolute, eventType, stats)
  }

  const watcher = chokidar.watch(rootPath, {
    ignored: IGNORED_GLOBS,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    alwaysStat: true,
  })
  watcher.on('ready', () => { ready = true })
  watcher.on('add',    (p, s) => handleRawEvent('add',    p, s))
  watcher.on('change', (p, s) => handleRawEvent('change', p, s))
  watcher.on('unlink', (p)    => handleRawEvent('unlink', p, null))
  watcher.on('error',  (err)  => { log.warn?.('workspace-watcher error:', err) })

  return {
    markSelfWrite(absolutePath, ttlMs = selfWriteMs) {
      selfWrites.set(absolutePath, now() + ttlMs)
    },
    async close() {
      for (const { timer } of debounceTimers.values()) clearTimeout(timer)
      debounceTimers.clear()
      selfWrites.clear()
      await watcher.close()
    },
  }
}
