import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  buildWorkspaceWindowLaunch,
  encodeWorkspaceWindowPath,
  openWorkspaceWindowProcess,
  readWorkspaceWindowRequest,
  WORKSPACE_WINDOW_FLAG,
  WORKSPACE_WINDOW_PATH_FLAG,
  workspaceWindowProfilePath,
} from './workspace-window.mjs'

describe('workspace window process helpers', () => {
  it('round-trips a portable workspace request without exposing the path in argv', () => {
    const workspacePath = path.resolve('/Users/alice/projects/notes')
    const encodedPath = encodeWorkspaceWindowPath(workspacePath)

    expect(encodedPath).not.toContain(workspacePath)
    expect(readWorkspaceWindowRequest([
      'electron',
      WORKSPACE_WINDOW_FLAG,
      `${WORKSPACE_WINDOW_PATH_FLAG}${encodedPath}`,
    ])).toEqual({ workspacePath })
  })

  it('builds Electron launch arguments for packaged and development apps', () => {
    const packaged = buildWorkspaceWindowLaunch({
      execPath: '/Applications/Kition.app/Contents/MacOS/Kition',
      profilePath: '/tmp/kition-profile',
      workspacePath: '/Users/alice/projects/notes',
    })
    const development = buildWorkspaceWindowLaunch({
      execPath: '/opt/electron',
      appEntry: '.',
      profilePath: '/tmp/kition-profile',
      workspacePath: '/Users/alice/projects/notes',
    })

    expect(packaged.args[0]).toBe('--user-data-dir=/tmp/kition-profile')
    expect(packaged.args[1]).toBe(WORKSPACE_WINDOW_FLAG)
    expect(development.args.slice(0, 3)).toEqual([
      '--user-data-dir=/tmp/kition-profile',
      '.',
      WORKSPACE_WINDOW_FLAG,
    ])
  })

  it('uses a stable per-workspace profile and an independent backend port', async () => {
    const unref = vi.fn()
    const once = vi.fn((event: string, callback: () => void) => {
      if (event === 'spawn') {
        callback()
      }
    })
    const spawnProcess = vi.fn(() => ({ once, unref }))
    const sharedDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-workspace-window-'))
    const workspacePath = path.resolve('/Users/alice/projects/notes')
    try {
      const result = await openWorkspaceWindowProcess({
        workspacePath,
        sharedDataDir,
        execPath: '/opt/electron',
        appEntry: '.',
        environment: { KITION_API_BINARY: '/tmp/kition-api' },
        reservePort: async () => 19423,
        spawnProcess,
      })

      expect(result).toEqual({
        backendPort: 19423,
        profilePath: workspaceWindowProfilePath(sharedDataDir, workspacePath),
      })
      expect(spawnProcess).toHaveBeenCalledWith(
        '/opt/electron',
        expect.arrayContaining([WORKSPACE_WINDOW_FLAG]),
        expect.objectContaining({
          detached: true,
          env: expect.objectContaining({
            KITION_DESKTOP_API_PORT: '19423',
            KITION_DESKTOP_SHARED_DATA_DIR: sharedDataDir,
          }),
        }),
      )
      expect(unref).toHaveBeenCalledOnce()
    } finally {
      await fs.rm(sharedDataDir, { recursive: true, force: true })
    }
  })
})
