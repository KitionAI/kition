import path from 'node:path'

export function createDevViteConfig(uiDir) {
  const root = path.resolve(uiDir)
  return {
    root,
    configFile: path.join(root, 'tooling', 'vite.config.ts'),
    clearScreen: false,
    logLevel: 'info',
    server: {
      host: '127.0.0.1',
      port: 3000,
      strictPort: false,
    },
  }
}

export function shouldTerminateDevProcess(entry, options) {
  const currentPid = Number(options?.currentPid || 0)
  const uiDir = String(options?.uiDir || '').replaceAll('\\', '/')
  const command = String(entry?.command || '').replaceAll('\\', '/')

  if (!entry?.pid || entry.pid === currentPid || !uiDir || !command.includes(uiDir)) {
    return false
  }

  return (
    command.includes('/electron/scripts/dev-electron.mjs')
    || command.includes('node electron/scripts/dev-electron.mjs')
    || command.includes('/electron/dist/Electron')
    || command.includes('/vite/bin/vite.js')
    || command.includes('/node_modules/.bin/vite')
  )
}
