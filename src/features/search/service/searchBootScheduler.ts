type IdleWindow = typeof window & {
  requestIdleCallback?: (task: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

export function scheduleSearchBoot(callback: () => void): () => void {
  const idleWindow = window as IdleWindow
  let idleId: number | null = null
  const timeoutId = window.setTimeout(() => {
    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(callback, { timeout: 1500 })
    } else {
      callback()
    }
  }, 2000)

  return () => {
    window.clearTimeout(timeoutId)
    if (idleId != null) idleWindow.cancelIdleCallback?.(idleId)
  }
}
