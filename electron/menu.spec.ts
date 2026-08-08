import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildFromTemplate = vi.fn((template) => ({ template }))

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate,
  },
}))

async function loadMenuModule() {
  vi.resetModules()
  return import('./menu.mjs')
}

describe('application menu window shortcuts', () => {
  beforeEach(() => {
    buildFromTemplate.mockClear()
  })

  it('assigns Command+M as the minimize accelerator on macOS only', async () => {
    const { getDevToolsAccelerator, getWindowMinimiseAccelerator } = await loadMenuModule()

    expect(getWindowMinimiseAccelerator('darwin')).toBe('Command+M')
    expect(getWindowMinimiseAccelerator('win32')).toBeUndefined()
    expect(getWindowMinimiseAccelerator('linux')).toBeUndefined()
    expect(getDevToolsAccelerator('darwin')).toBe('Alt+Command+I')
    expect(getDevToolsAccelerator('win32')).toBe('F12')
    expect(getDevToolsAccelerator('linux')).toBe('F12')
  })

  it('wires window accelerators into the window menu', async () => {
    const { buildApplicationMenu } = await loadMenuModule()

    buildApplicationMenu(
      null,
      {
        windowAction: vi.fn(),
        openRuntimePath: vi.fn(),
        showAboutDialog: vi.fn(),
      },
      'darwin',
    )

    const [template] = buildFromTemplate.mock.calls.at(-1) || []
    const windowMenu = template.find((item) => item.label === 'Window')
    const minimizeItem = windowMenu?.submenu.find((item) => item.label === 'Minimize')
    const devToolsItem = windowMenu?.submenu.find((item) => item.label === 'Toggle Developer Tools')

    expect(minimizeItem?.accelerator).toBe('Command+M')
    expect(devToolsItem?.accelerator).toBe('Alt+Command+I')
  })

  it('removes the application menu on Windows', async () => {
    const { buildApplicationMenu } = await loadMenuModule()

    const menu = buildApplicationMenu(
      null,
      {
        windowAction: vi.fn(),
        openRuntimePath: vi.fn(),
        showAboutDialog: vi.fn(),
      },
      'win32',
    )

    expect(menu).toBeNull()
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })
})
