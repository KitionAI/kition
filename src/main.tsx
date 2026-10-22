// First: takes this launch's API token off `window` before any other code runs.
import './services/runtimeAuth'
import './services/desktopClient/tauriBridge'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import { installKitionDocumentHost } from './features/document/host/kitionDocumentHost'
import { QueryProvider } from './app/QueryProvider'
import { i18nReady } from './i18n'
import { installFileDropGuard } from './lib/fileDropGuard'
import './app/styles.css'
import './app/kit-colors.css'
import './styles/desktop-display.css'

installFileDropGuard()
installKitionDocumentHost()

window.addEventListener('error', (event) => {
  if (event.message === 'ResizeObserver loop completed with undelivered notifications.') {
    event.stopImmediatePropagation()
  }
})

void i18nReady.then(() => {
  ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
    <React.StrictMode>
      <QueryProvider>
        <App />
      </QueryProvider>
    </React.StrictMode>,
  )
})
