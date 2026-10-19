import { createRoot } from 'react-dom/client'
import { connectHost, createKitStrings, toast } from '@kition/kit-ui'
import { setDocumentHost } from '@kition/document-editor'
// Kition's stylesheet first (its theme variables, Tailwind, and the editor's classes), then
// kit-ui's, so the shell keeps its own look over Tailwind's reset.
import '../../../../src/app/styles.css'
import '@kition/kit-ui/styles.css'
import './app.css'
import { App } from './App'
import { startDocumentI18n } from './i18n'
import { CATALOGS } from './strings'

const root = createRoot(document.getElementById('root')!)

// Opened outside a host, the page says where it belongs instead of waiting forever.
const alone = window.setTimeout(() => {
  const t = createKitStrings(CATALOGS, navigator.language)
  root.render(<div className="kui-alone">{t('noHost')}</div>)
}, 3000)

/**
 * What the document editor asks of its app, in a kit: notices only. Images show where their URL
 * loads by itself, pasted images stay links, and wikilinks have no notes to preview: the host's
 * files are not the kit's to read or write.
 */
setDocumentHost({
  notify: (kind, message, options) => toast(kind === 'success' ? 'success' : 'error', message, options?.description),
})

void connectHost({ id: 'kit.document', version: '0.1.0', capabilities: ['ai'] }).then(async (host) => {
  window.clearTimeout(alone)
  const i18n = await startDocumentI18n(host.init.locale)
  // No StrictMode: its doubled effects would open the document twice, in two engine workers.
  root.render(<App host={host} i18n={i18n} />)
})
