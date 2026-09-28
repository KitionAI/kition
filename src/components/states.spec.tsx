import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmptyState, InlineError, SkeletonRows } from './states'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container.remove()
})

describe('shared states', () => {
  it('renders skeleton rows as a labelled status region', async () => {
    await act(async () => root!.render(createElement(SkeletonRows, { rows: 4, label: 'Loading vaults' })))
    const region = container.querySelector('[role="status"]')
    expect(region?.getAttribute('aria-label')).toBe('Loading vaults')
    expect(region?.children).toHaveLength(4)
  })

  it('renders the empty state with its action', async () => {
    await act(async () => root!.render(createElement(EmptyState, { title: 'No workflows', description: 'Create one', action: createElement('button', null, 'Create'), 'data-testid': 'empty' })))
    expect(container.querySelector('[data-testid="empty"] h2')?.textContent).toBe('No workflows')
    expect(container.querySelector('[data-testid="empty"] button')?.textContent).toBe('Create')
  })

  it('renders an alert with a retry button only when a handler is given', async () => {
    const onRetry = vi.fn()
    await act(async () => root!.render(createElement(InlineError, { message: 'Request failed', onRetry, retryLabel: 'Try again' })))
    const alert = container.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Request failed')
    const button = alert.querySelector('button')!
    expect(button.textContent).toBe('Try again')
    button.click()
    expect(onRetry).toHaveBeenCalledTimes(1)

    await act(async () => root!.render(createElement(InlineError, { message: 'Plain', size: 'xs' })))
    expect(container.querySelector('[role="alert"] button')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.className).toContain('text-[11px]')
  })
})
