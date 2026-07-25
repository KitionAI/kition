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
