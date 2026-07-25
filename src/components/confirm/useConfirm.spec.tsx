import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'

import { ConfirmProvider } from './ConfirmProvider'
import { useConfirm } from './useConfirm'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

// Helper component that exposes the confirm function via a ref-like callback
let capturedConfirm: ReturnType<typeof useConfirm> | null = null

function TestHarness({ onReady }: { onReady?: () => void }) {
  capturedConfirm = useConfirm()
  onReady?.()
  return null
}

function AppWithProvider({ onReady }: { onReady?: () => void }) {
  return createElement(
    ConfirmProvider,
    null,
    createElement(TestHarness, { onReady })
  )
}

describe('useConfirm', () => {
  beforeEach(async () => {
    capturedConfirm = null
    await unmount()
  })

  it('confirm button click resolves true', async () => {
    await mount(createElement(AppWithProvider, null))

    let result: boolean | undefined
    await act(async () => {
      const promise = capturedConfirm!({ message: 'Are you sure?' })
      promise.then((v) => { result = v })
      await Promise.resolve()
    })

    // dialog should be open; find and click the confirm button
    const confirmBtn = document.querySelector('[data-testid="confirm-btn"]') as HTMLButtonElement
    expect(confirmBtn).not.toBeNull()

    await act(async () => {
      confirmBtn.click()
      await Promise.resolve()
    })

    expect(result).toBe(true)
  })

  it('cancel button click resolves false', async () => {
    await mount(createElement(AppWithProvider, null))

    let result: boolean | undefined
    await act(async () => {
      const promise = capturedConfirm!({ message: 'Are you sure?' })
      promise.then((v) => { result = v })
      await Promise.resolve()
    })

    const cancelBtn = document.querySelector('[data-testid="cancel-btn"]') as HTMLButtonElement
    expect(cancelBtn).not.toBeNull()

    await act(async () => {
      cancelBtn.click()
      await Promise.resolve()
    })

    expect(result).toBe(false)
  })

  it('Escape key resolves false', async () => {
    await mount(createElement(AppWithProvider, null))

    let result: boolean | undefined
    await act(async () => {
      const promise = capturedConfirm!({ message: 'Press escape' })
      promise.then((v) => { result = v })
      await Promise.resolve()
    })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    expect(result).toBe(false)
  })

  it('custom confirmLabel and cancelLabel are shown', async () => {
    await mount(createElement(AppWithProvider, null))

    await act(async () => {
      const promise = capturedConfirm!({
        message: 'Delete?',
        confirmLabel: 'Yes, delete',
        cancelLabel: 'Keep it',
      })
      promise.catch(() => {})
      await Promise.resolve()
    })

    const confirmBtn = document.querySelector('[data-testid="confirm-btn"]') as HTMLButtonElement
    const cancelBtn = document.querySelector('[data-testid="cancel-btn"]') as HTMLButtonElement

    expect(confirmBtn?.textContent).toBe('Yes, delete')
    expect(cancelBtn?.textContent).toBe('Keep it')

    // cleanup
    await act(async () => {
      cancelBtn?.click()
      await Promise.resolve()
    })
  })

  it('destructive variant: initial focus on cancel button', async () => {
    await mount(createElement(AppWithProvider, null))

    await act(async () => {
      const promise = capturedConfirm!({
        message: 'Delete everything?',
        variant: 'destructive',
      })
      promise.catch(() => {})
      await Promise.resolve()
    })

    // Give focus effect time to run
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const cancelBtn = document.querySelector('[data-testid="cancel-btn"]') as HTMLButtonElement
    expect(cancelBtn).not.toBeNull()
    expect(document.activeElement).toBe(cancelBtn)

    // cleanup
    await act(async () => {
      cancelBtn?.click()
      await Promise.resolve()
    })
  })

  it('default variant: initial focus on confirm button', async () => {
    await mount(createElement(AppWithProvider, null))

    await act(async () => {
      const promise = capturedConfirm!({
        message: 'Proceed?',
        variant: 'default',
      })
      promise.catch(() => {})
      await Promise.resolve()
    })

    // Give focus effect time to run
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const confirmBtn = document.querySelector('[data-testid="confirm-btn"]') as HTMLButtonElement
    expect(confirmBtn).not.toBeNull()
    expect(document.activeElement).toBe(confirmBtn)

    // cleanup
    await act(async () => {
      confirmBtn?.click()
      await Promise.resolve()
    })
  })

  it('string shorthand confirm("quick?") works', async () => {
    await mount(createElement(AppWithProvider, null))

    let result: boolean | undefined
    await act(async () => {
      const promise = capturedConfirm!('quick?')
      promise.then((v) => { result = v })
      await Promise.resolve()
    })

    const messageEl = document.querySelector('[data-testid="confirm-message"]')
    expect(messageEl?.textContent).toBe('quick?')

    const confirmBtn = document.querySelector('[data-testid="confirm-btn"]') as HTMLButtonElement
    await act(async () => {
      confirmBtn.click()
      await Promise.resolve()
    })

    expect(result).toBe(true)
  })

  it('unmounting provider while dialog is open resolves promise with false', async () => {
    await mount(createElement(AppWithProvider, null))

    let result: boolean | undefined
    await act(async () => {
      const promise = capturedConfirm!({ message: 'Pending dialog' })
      promise.then((v) => { result = v })
      await Promise.resolve()
    })

    // dialog should be open
    const confirmBtn = document.querySelector('[data-testid="confirm-btn"]')
    expect(confirmBtn).not.toBeNull()

    // unmount the provider — cleanup effect should resolve pending promise with false
    await unmount()

    // flush microtasks so the .then() callback runs
    await act(async () => {
      await Promise.resolve()
    })

    expect(result).toBe(false)
  })
})
