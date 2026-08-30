import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import {
  DESKTOP_DOCUMENT_EXTERNAL_CHANGE_EVENT,
  DESKTOP_MENU_EVENT,
  DESKTOP_UPDATES_EVENT,
  IPC_CHANNELS,
} from './channels.mjs'

const preloadSource = fs.readFileSync(path.resolve(process.cwd(), 'electron/preload.cjs'), 'utf8')

describe('sandboxed desktop preload', () => {
  it('is self-contained and exposes the desktop bridge', async () => {
    const exposeInMainWorld = vi.fn()
    const invoke = vi.fn().mockResolvedValue({ workspace_dir: '/workspace' })
    const on = vi.fn()
    const removeListener = vi.fn()

    vm.runInNewContext(preloadSource, {
      Boolean,
      process: {
        argv: ['electron', '--kition-backend-origin=http://127.0.0.1:19101'],
      },
      require: (id: string) => {
        if (id !== 'electron') throw new Error(`unexpected preload dependency: ${id}`)
        return {
          contextBridge: { exposeInMainWorld },
          ipcRenderer: { invoke, on, removeListener },
        }
      },
    })

    expect(exposeInMainWorld).toHaveBeenCalledOnce()
    const [bridgeName, bridge] = exposeInMainWorld.mock.calls[0] as [string, Record<string, any>]
    expect(bridgeName).toBe('kitionDesktop')
    expect(bridge.backendOrigin).toBe('http://127.0.0.1:19101')
    expect(bridge.menuEvent).toBe(DESKTOP_MENU_EVENT)
    expect(bridge.updatesEvent).toBe(DESKTOP_UPDATES_EVENT)
    expect(bridge.documentExternalChangeEvent).toBe(DESKTOP_DOCUMENT_EXTERNAL_CHANGE_EVENT)

    await bridge.DesktopInfo()
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.desktopInfo)

    await bridge.ReadBundledAsset({ path: 'onboarding/manifest.json' })
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.readBundledAsset,
      { path: 'onboarding/manifest.json' },
    )

    await bridge.ReadClipboardImage()
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.readClipboardImage)

    await bridge.ChooseAgentAnalysisDirectory({ suggested_path: '../project' })
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.chooseAgentAnalysisDirectory,
      { suggested_path: '../project' },
    )

    await bridge.OpenWorkspaceWindow({ path: '/Users/alice/projects/notes' })
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.openWorkspaceWindow,
      { path: '/Users/alice/projects/notes' },
    )

    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(preloadSource).toContain(`'${channel}'`)
    }
    expect(Array.from(preloadSource.matchAll(/require\(['"]([^'"]+)['"]\)/g), (match) => match[1]))
      .toEqual(['electron'])
  })
})
