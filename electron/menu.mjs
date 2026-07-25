import { Menu } from 'electron'
import { DESKTOP_MENU_EVENT } from './channels.mjs'

function emit(win, action, payload = {}) {
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send(DESKTOP_MENU_EVENT, { action, ...payload })
}

export function getWindowMinimiseAccelerator(platform = process.platform) {
  return platform === 'darwin' ? 'Command+M' : undefined
}

export function getDevToolsAccelerator(platform = process.platform) {
  return platform === 'darwin' ? 'Alt+Command+I' : 'F12'
}

export function buildApplicationMenu(win, handlers, platform = process.platform) {
  const template = [
    ...(platform === 'darwin'
      ? [
          {
            role: 'appMenu',
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Settings', click: () => emit(win, 'navigate-settings') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Center Window', click: () => handlers.windowAction('center') },
        { label: 'Toggle Full Screen', click: () => handlers.windowAction('fullscreen') },
        { label: 'Reload Current Page', click: () => handlers.windowAction('reload') },
        { label: 'Toggle Developer Tools', accelerator: getDevToolsAccelerator(platform), click: () => handlers.windowAction('toggle-devtools') },
        {
          label: 'Minimize',
          accelerator: getWindowMinimiseAccelerator(platform),
          click: () => handlers.windowAction('minimise'),
        },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}
