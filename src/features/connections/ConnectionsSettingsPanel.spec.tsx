import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createConnection,
  listChannels,
  listConnections,
  testConnection,
  updateConnection,
} from '@/features/connections/api'
import { ConnectionModal, ConnectionsSettingsPanel } from './ConnectionsSettingsPanel'

vi.mock('@/features/connections/api', () => ({
  listChannels: vi.fn(),
  listConnections: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  deleteConnection: vi.fn(),
  testConnection: vi.fn(),
}))

let container: HTMLDivElement
let root: Root | null = null

const channel = {
  channel: 'email_smtp',
  label: 'Email SMTP',
  icon: 'mail',
  description: 'Email',
  auth: 'form',
  fields: [{ key: 'tlsMode', label: 'TLS', type: 'select', options: [{ value: 'starttls', label: 'STARTTLS' }] }],
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  ;(listChannels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([channel])
  ;(listConnections as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([])
  ;(createConnection as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: 'conn_1',
    channel: 'email_smtp',
    name: 'SMTP',
    settings: { host: 'smtp.example.com', from: 'from@example.com' },
    status: 'active',
    createdAt: '',
    updatedAt: '',
  })
  ;(testConnection as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
  await flush()
}

function input(testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function selectValue(testId: string, value: string) {
  const select = container.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ConnectionsSettingsPanel', () => {
  it('renders an empty connections state from real API shape', async () => {
    await mount(createElement(ConnectionsSettingsPanel))
    expect(container.querySelector('[data-testid="connections-settings-panel"]')?.textContent).toContain('No delivery accounts yet')
  })

  it('treats malformed list responses as empty instead of crashing settings', async () => {
    const listChannelsMock = listChannels as unknown as ReturnType<typeof vi.fn>
    const listConnectionsMock = listConnections as unknown as ReturnType<typeof vi.fn>
    listChannelsMock.mockResolvedValueOnce({})
    listConnectionsMock.mockResolvedValueOnce(null)

    await mount(createElement(ConnectionsSettingsPanel))

    expect(container.querySelector('[data-testid="connections-settings-panel"]')?.textContent).toContain('No delivery accounts yet')
  })

  it('renders a provider connection editor inline without a second dialog', async () => {
    await mount(createElement(ConnectionsSettingsPanel, { embedded: true, providerId: '163' }))

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).toContain('163 Mail')
    expect(input('connection-username')).not.toBeNull()
    expect(container.querySelector('[data-testid="connection-provider"]')).toBeNull()
  })

  it('submits secrets on create without expecting them in the response', async () => {
    vi.useFakeTimers()
    const onSaved = vi.fn()
    await mount(createElement(ConnectionModal, { channel, onClose: vi.fn(), onSaved }))
    await act(async () => {
      selectValue('connection-provider', '163')
      setValue(input('connection-username'), 'person@163.com')
      setValue(input('connection-password'), 'secret-password')
    })
    await act(async () => {
      (container.querySelector('[data-testid="connection-save"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email_smtp',
      secrets: { password: 'secret-password' },
      name: '163 Mail delivery',
      settings: expect.objectContaining({
        host: 'smtp.163.com',
        port: 465,
        tlsMode: 'tls',
        from: 'person@163.com',
      }),
    }))
    // Success path: success message renders, modal stays open briefly,
    // then onSaved fires after the auto-close delay.
    expect(onSaved).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Connection verified')
    await act(async () => {
      vi.advanceTimersByTime(1300)
      await Promise.resolve()
    })
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'conn_1' }))
    vi.useRealTimers()
  })

  it('keeps the modal open and surfaces the error when verification fails', async () => {
    vi.useFakeTimers()
    ;(createConnection as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'conn_bad',
      channel: 'email_smtp',
      name: 'SMTP',
      settings: { host: 'smtp.example.com', from: 'from@example.com' },
      status: 'invalid',
      lastErrorMessage: 'dial tcp 173.194.74.108:587: i/o timeout',
      createdAt: '',
      updatedAt: '',
    })
    const onSaved = vi.fn()
    const onClose = vi.fn()
    await mount(createElement(ConnectionModal, { channel, onClose, onSaved }))
    await act(async () => {
      setValue(input('connection-username'), 'apikey')
      setValue(input('connection-password'), 'secret-password')
    })
    await act(async () => {
      (container.querySelector('[data-testid="connection-save"]') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const errorBox = container.querySelector('[data-testid="connection-error"]')
    expect(errorBox?.textContent).toContain('dial tcp')
    // Even after the would-be auto-close delay, nothing closes.
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(updateConnection).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
