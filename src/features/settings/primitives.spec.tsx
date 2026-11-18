import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  SettingsActionBar,
  SettingsPaneHeader,
  SettingsRow,
  SettingsSection,
  SettingsSidebarHeader,
} from './primitives'

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
  await act(async () => { root?.unmount() })
  root = null
  container?.remove()
}

describe('SettingsPaneHeader', () => {
  beforeEach(async () => { await unmount() })

  it('renders title and description', async () => {
    await mount(createElement(SettingsPaneHeader, {
      title: 'AI Models',
      description: 'Connect providers',
    }))
    expect(container.textContent).toContain('AI Models')
    expect(container.textContent).toContain('Connect providers')
  })
})

describe('SettingsSection + SettingsRow', () => {
  beforeEach(async () => { await unmount() })

  it('renders section title and children rows', async () => {
    await mount(createElement(SettingsSection, { title: 'Connection' },
      createElement(SettingsRow, { title: 'Provider name' },
        createElement('input', { 'data-testid': 'inp' }))))
    expect(container.textContent).toContain('Connection')
    expect(container.textContent).toContain('Provider name')
    expect(container.querySelector('[data-testid="inp"]')).not.toBeNull()
  })
})

describe('SettingsSidebarHeader', () => {
  beforeEach(async () => { await unmount() })

  it('calls onSearchChange when input changes', async () => {
    let received = ''
    await mount(createElement(SettingsSidebarHeader, {
      search: '',
      onSearchChange: (value: string) => { received = value },
    }))
    const input = container.querySelector('input') as HTMLInputElement
    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeValueSetter.call(input, 'model')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(received).toBe('model')
  })

  it('shows the Settings header label', async () => {
    await mount(createElement(SettingsSidebarHeader, {
      search: '', onSearchChange: () => {},
    }))
    expect(container.textContent).toContain('Settings')
  })
})

describe('SettingsActionBar', () => {
  beforeEach(async () => { await unmount() })

  it('renders nothing when not dirty', async () => {
    await mount(createElement(SettingsActionBar, {
      dirty: false, onSave: () => {}, onCancel: () => {},
    }))
    expect(container.querySelector('.settings-action-bar')).toBeNull()
  })

  it('renders Cancel + Save buttons when dirty', async () => {
    await mount(createElement(SettingsActionBar, {
      dirty: true, onSave: () => {}, onCancel: () => {},
    }))
    const bar = container.querySelector('.settings-action-bar')!
    expect(bar).not.toBeNull()
    expect(bar.textContent).toContain('Save')
    expect(bar.textContent).toContain('Cancel')
    expect(bar.textContent).toContain('Unsaved changes')
  })

  it('renders destructive slot on the left when provided', async () => {
    await mount(createElement(SettingsActionBar, {
      dirty: true, onSave: () => {}, onCancel: () => {},
      destructive: createElement('button', { 'data-testid': 'destroy' }, 'Disconnect'),
    }))
    expect(container.querySelector('[data-testid="destroy"]')).not.toBeNull()
  })
})
