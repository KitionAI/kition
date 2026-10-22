import { createRoot } from 'react-dom/client'
import { connectHost, createKitStrings } from '@kition/kit-ui'
// Kition's stylesheet first (its theme variables, Tailwind, and component classes), then kit-ui's,
// so the shell keeps its own look over Tailwind's reset.
import '../../../../src/app/styles.css'
import '@kition/kit-ui/styles.css'
import './app.css'
import { App } from './App'
import { createBoardI18n } from './i18n'
import { CATALOGS } from './strings'
import manifest from '../../kit.json'

const root = createRoot(document.getElementById('root')!)

// Opened outside a host, the page says where it belongs instead of waiting forever.
const alone = window.setTimeout(() => {
  const t = createKitStrings(CATALOGS, navigator.language)
  root.render(<div className="kui-alone">{t('noHost')}</div>)
}, 3000)

void connectHost({ id: 'kit.board', version: '0.1.0', capabilities: ['ai'], brand: manifest.ui.brand }).then(async (host) => {
  window.clearTimeout(alone)
  const i18n = await createBoardI18n(host.init.locale)
  // No StrictMode: its doubled effects would open the document twice, in two engine workers.
  root.render(<App host={host} i18n={i18n} />)
})
