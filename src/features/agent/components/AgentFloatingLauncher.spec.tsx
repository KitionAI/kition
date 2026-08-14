import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentFloatingLauncher } from './AgentFloatingLauncher'

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
})

describe('AgentFloatingLauncher', () => {
  it('renders the accessible project icon launcher when the panel is closed', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(AgentFloatingLauncher, {
        visible: true,
        onOpen: vi.fn(),
      }))
    })

    const button = container.querySelector<HTMLButtonElement>('[data-testid="agent-floating-launcher"]')
    expect(button?.getAttribute('aria-label')).toBe('Open AI Chat')
    const icon = button?.querySelector<SVGElement>('.agent-floating-launcher__icon')
    expect(icon).toBeTruthy()
    expect(icon?.getAttribute('viewBox')).toBe('190 135 660 700')
    expect(icon?.querySelector('.agent-floating-launcher__eyes')).toBeTruthy()
  })

  it('opens the agent panel when clicked', () => {
    const onOpen = vi.fn()
    act(() => {
      root = createRoot(container)
      root.render(createElement(AgentFloatingLauncher, { visible: true, onOpen }))
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-floating-launcher"]')?.click()
    })

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('does not render while the agent panel is open', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(AgentFloatingLauncher, {
        visible: false,
        onOpen: vi.fn(),
      }))
    })

    expect(container.querySelector('[data-testid="agent-floating-launcher"]')).toBeNull()
  })
})
