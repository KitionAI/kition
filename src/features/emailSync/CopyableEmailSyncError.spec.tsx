import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { CopyableEmailSyncError } from './CopyableEmailSyncError'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
})

it('copies the complete error message', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  const message = 'parse message UID 42: unexpected EOF'
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(CopyableEmailSyncError, { message }))
    await Promise.resolve()
  })

  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="Copy error"]')?.click()
    await Promise.resolve()
  })

  expect(writeText).toHaveBeenCalledWith(message)
  expect(container.querySelector('[aria-label="Error copied"]')).not.toBeNull()
})
