// First: takes this launch's API token off `window` before any other code runs.
import './services/runtimeAuth'
import './services/desktopClient/tauriBridge'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import { QueryProvider } from './app/QueryProvider'
import { i18nReady } from './i18n'
import { loadKitCatalog } from './lib/kitCatalog'
import { installFileDropGuard } from './lib/fileDropGuard'
import './app/styles.css'
import './styles/desktop-display.css'

installFileDropGuard()

window.addEventListener('error', (event) => {
  if (event.message === 'ResizeObserver loop completed with undelivered notifications.') {
    event.stopImmediatePropagation()
  }
})

// The kit catalog (each kit package's manifest) is read before the first render: what a file is,
// which kit opens it and what the create menu offers all come from it.
void Promise.all([i18nReady, loadKitCatalog()]).then(() => {
  ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
    <React.StrictMode>
      <QueryProvider>
        <App />
      </QueryProvider>
    </React.StrictMode>,
  )
})
