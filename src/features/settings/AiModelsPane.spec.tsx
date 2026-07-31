import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const accountMock = vi.hoisted(() => ({
  current: {} as any,
}))
const apiMocks = vi.hoisted(() => ({
  discoverProviderModels: vi.fn(),
}))

vi.mock('@/features/account/hooks/useKitionAccount', () => ({
  useKitionAccount: () => accountMock.current,
}))

vi.mock('@/api/desktop', () => ({
  discoverProviderModels: apiMocks.discoverProviderModels,
}))

vi.mock('@/services/desktopSettings', async () => {
  const actual: any = await vi.importActual('@/services/desktopSettings')
  return {
    ...actual,
    loadDesktopSettings: vi.fn(async () => actual.createDefaultDesktopSettings()),
    saveDesktopSettings: vi.fn(async (settings) => settings),
  }
})

import { AiModelsPane } from './AiModelsPane'
import { desktopProviderCatalog } from '@/services/desktopSettings'

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
    await Promise.resolve()
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  })
}

describe('AiModelsPane', () => {
  beforeEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    container?.remove()
    accountMock.current = {
      state: { status: 'signed_out', session: null, errorMessage: '' },
      ensureReady: vi.fn().mockResolvedValue(null),
      cancelConnect: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
    }
    apiMocks.discoverProviderModels.mockReset()
    apiMocks.discoverProviderModels.mockResolvedValue({
      models: ['gpt-5.5', 'gpt-image-2'],
      fetched_at: '2026-07-29T10:00:00Z',
    })
  })

  it('renders every configured provider in the rail', async () => {
    await mount(createElement(AiModelsPane))
    const rows = container.querySelectorAll('.settings-provider-row')
    expect(rows.length).toBe(desktopProviderCatalog.length)
    expect(rows[0]?.textContent).toContain('Kition Cloud')
    expect(Array.from(rows).some((row) => row.textContent?.includes('DeepSeek'))).toBe(true)
    expect(Array.from(rows).some((row) => row.textContent?.includes('Kimi'))).toBe(true)
  })

  it('shows the Kimi API key configuration', async () => {
    await mount(createElement(AiModelsPane))
    const kimiRow = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-provider-row'))
      .find((row) => row.textContent?.includes('Kimi'))!

    await act(async () => { kimiRow.click() })

    expect(container.querySelector('.settings-provider-editor-head')?.textContent).toContain('Moonshot AI models')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="API key"]')).not.toBeNull()
  })

  it('does not render the placeholder default model section', async () => {
    await mount(createElement(AiModelsPane))

    expect(container.textContent).not.toContain('Default model')
    expect(container.textContent).not.toContain('Used by new agents and chats')
  })

  it('switches the active provider on click', async () => {
    await mount(createElement(AiModelsPane))
    const rows = container.querySelectorAll<HTMLButtonElement>('.settings-provider-row')
    await act(async () => { rows[2].click() })
    const active = container.querySelector('.settings-provider-row.is-active')
    expect(active).toBe(rows[2])
  })

  it('shows Kition Cloud as signed out without a connected indicator', async () => {
    await mount(createElement(AiModelsPane))
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-provider-row'))
    const cloudRow = rows.find((row) => row.textContent?.includes('Kition Cloud'))!
    await act(async () => { cloudRow.click() })

    expect(cloudRow.querySelector('.settings-provider-dot')?.classList.contains('is-on')).toBe(false)
    expect(container.querySelector('[data-testid="kition-account-connect"]')?.textContent).toContain('Sign in')
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Advanced')).toBe(false)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Disconnect')).toBe(false)
  })

  it('shows a connected indicator and Disconnect only when the account is ready', async () => {
    accountMock.current.state = { status: 'ready', session: { access_token: 'token' }, errorMessage: '' }
    await mount(createElement(AiModelsPane))
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-provider-row'))
    const cloudRow = rows.find((row) => row.textContent?.includes('Kition Cloud'))!
    await act(async () => { cloudRow.click() })

    expect(cloudRow.querySelector('.settings-provider-dot')?.classList.contains('is-on')).toBe(true)
    expect(container.querySelector('[data-testid="kition-account-connect"]')).toBeNull()
    expect(container.querySelector('[data-testid="kition-cloud-model-list"]')?.textContent).toContain('gpt-5.5')
    expect(container.querySelector('[data-testid="kition-cloud-model-list"]')?.textContent).toContain('gpt-image-2')
    expect(container.querySelector('[data-testid="kition-cloud-model-list"]')?.textContent).not.toContain('gpt-image-1')
    expect(container.querySelector('[data-testid="kition-cloud-model-list"]')?.textContent).not.toContain('dall-e-3')
    expect(container.textContent).not.toContain('3 hosted models available')
    expect(apiMocks.discoverProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      provider_type: 'kition_console',
    }))
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Disconnect')).toBe(true)
  })

  it('keeps low-credit accounts connected and usable', async () => {
    accountMock.current.state = {
      status: 'credits_low',
      session: { access_token: 'token', credit_total: 100, credit_balance: 20 },
      errorMessage: '',
    }
    await mount(createElement(AiModelsPane))
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-provider-row'))
    const cloudRow = rows.find((row) => row.textContent?.includes('Kition Cloud'))!
    await act(async () => { cloudRow.click() })

    expect(cloudRow.querySelector('.settings-provider-dot')?.classList.contains('is-on')).toBe(true)
    expect(container.querySelector('[data-testid="kition-account-status"]')?.textContent).toContain('credits low')
    expect(container.querySelector('[data-testid="kition-account-connect"]')).toBeNull()
  })

  it('shows top-up recovery while keeping sign-out available when credits are empty', async () => {
    accountMock.current.state = {
      status: 'credits_empty',
      session: { access_token: 'token', credit_total: 100, credit_balance: 0 },
      errorMessage: '',
    }
    await mount(createElement(AiModelsPane))
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-provider-row'))
    const cloudRow = rows.find((row) => row.textContent?.includes('Kition Cloud'))!
    await act(async () => { cloudRow.click() })

    expect(cloudRow.querySelector('.settings-provider-dot')?.classList.contains('is-on')).toBe(false)
    expect(container.querySelector('[data-testid="kition-account-connect"]')?.textContent).toContain('Top up credits')
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Disconnect')).toBe(true)
  })
})
