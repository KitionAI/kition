import { describe, expect, it } from 'vitest'

import { shouldTerminateDevProcess } from './dev-processes.mjs'

const uiDir = '/workspace/kition'
const options = { uiDir, currentPid: 100 }

describe('shouldTerminateDevProcess', () => {
  it('recognizes pnpm and direct Vite child processes in the same repository', () => {
    expect(shouldTerminateDevProcess({
      pid: 101,
      command: `node ${uiDir}/node_modules/.bin/vite --host 127.0.0.1`,
    }, options)).toBe(true)
    expect(shouldTerminateDevProcess({
      pid: 102,
      command: `node ${uiDir}/node_modules/vite/bin/vite.js --port 3000`,
    }, options)).toBe(true)
  })

  it('recognizes Electron and nested dev-electron processes', () => {
    expect(shouldTerminateDevProcess({
      pid: 103,
      command: `${uiDir}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`,
    }, options)).toBe(true)
    expect(shouldTerminateDevProcess({
      pid: 104,
      command: `node ${uiDir}/electron/scripts/dev-electron.mjs`,
    }, options)).toBe(true)
  })

  it('leaves the current process and other repositories alone', () => {
    expect(shouldTerminateDevProcess({
      pid: 100,
      command: `node ${uiDir}/node_modules/.bin/vite`,
    }, options)).toBe(false)
    expect(shouldTerminateDevProcess({
      pid: 105,
      command: 'node /workspace/other/node_modules/.bin/vite',
    }, options)).toBe(false)
  })
})
