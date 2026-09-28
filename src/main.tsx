import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import { QueryProvider } from './app/QueryProvider'
import { i18nReady } from './i18n'
import './app/styles.css'
import './styles/desktop-display.css'

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
