import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accountMock = vi.hoisted(() => ({ current: {} as any }))

vi.mock('@/features/account/hooks/useKitionAccount', () => ({
  useKitionAccount: () => accountMock.current,
}))

import { FirstRunActivationPanel } from './FirstRunActivationPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

const callbacks = {
  onStartCloud: vi.fn(),
  onConfigureModels: vi.fn(),
  onStartLocal: vi.fn(),
  onSkip: vi.fn(),
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(FirstRunActivationPanel, {
      workspaceName: 'Commercial Workspace',
      ...callbacks,
    }))
    await Promise.resolve()
  })
}

async function click(selector: string) {
  await act(async () => {
    const button = container.querySelector(selector) as HTMLButtonElement
    button.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  Object.values(callbacks).forEach((callback) => callback.mockReset())
  accountMock.current = {
    state: { status: 'signed_out', session: null, errorMessage: '' },
    ensureReady: vi.fn().mockResolvedValue(null),
    cancelConnect: vi.fn(),
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('FirstRunActivationPanel', () => {
  it('shows every start path on one screen', async () => {
    await mount()

    expect(container.textContent).toContain('Commercial Workspace')
    expect(container.textContent).toContain('Kition Cloud')
    expect(container.textContent).toContain('Bring your own API key')
    expect(container.textContent).toContain('Continue without AI')
    expect(container.querySelector('[data-testid="first-run-step-workspace"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="first-run-continue"]')).toBeNull()
  })

  it('routes bring-your-own-key users directly to AI Models', async () => {
    await mount()
    await click('[data-testid="first-run-configure-models"]')

    expect(callbacks.onConfigureModels).toHaveBeenCalledTimes(1)
  })

  it('opens the deterministic local example directly', async () => {
    await mount()
    await click('[data-testid="first-run-start-local"]')

    expect(callbacks.onStartLocal).toHaveBeenCalledTimes(1)
  })

  it('starts the cloud action only after a usable account is ready', async () => {
    accountMock.current.ensureReady.mockResolvedValue({
      access_token: 'token',
      token_prefix: 'prefix',
      user_id: 7,
      user_email: 'member@kition.ai',
      expires_at: 1_785_542_400_000,
      credit_total: 100,
      credit_balance: 80,
    })
    await mount()
    await click('[data-testid="first-run-start-cloud"]')

    expect(accountMock.current.ensureReady).toHaveBeenCalledTimes(1)
    expect(callbacks.onStartCloud).toHaveBeenCalledTimes(1)
  })

  it('keeps cancellation available while browser sign-in is pending', async () => {
    accountMock.current.state.status = 'connecting'
    await mount()

    const button = container.querySelector('[data-testid="first-run-start-cloud"]') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Cancel sign-in')
    await click('[data-testid="first-run-start-cloud"]')

    expect(accountMock.current.cancelConnect).toHaveBeenCalledTimes(1)
  })

  it('allows onboarding to be skipped without making a provider decision', async () => {
    await mount()
    const skipButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Skip for now')) as HTMLButtonElement
    await act(async () => skipButton.click())

    expect(callbacks.onSkip).toHaveBeenCalledTimes(1)
  })
})
