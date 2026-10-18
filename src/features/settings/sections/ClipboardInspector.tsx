import { useEffect, useState } from 'react'
import { Button } from '@kition/app-ui'
import { loadDocumentClipboard } from '@/features/document/public'
import { SettingsSection } from '@/features/settings/primitives'
import { useTranslation } from '@/i18n'
import { isDesktopRuntime, saveTextFile } from '@/services/desktop'

type ClipboardTools = Awaited<ReturnType<typeof loadDocumentClipboard>>
type Snapshot = ReturnType<ClipboardTools['inspectDocumentClipboard']>

export function ClipboardInspector() {
  const { t } = useTranslation('settings')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [tools, setTools] = useState<ClipboardTools | null>(null)
  useEffect(() => {
    let active = true
    void loadDocumentClipboard().then((loaded) => {
      if (active) setTools(loaded)
    })
    return () => {
      active = false
    }
  }, [])
  const [selectedType, setSelectedType] = useState('text/html')
  const [showPreview, setShowPreview] = useState(false)
  const [exportError, setExportError] = useState('')

  async function exportSnapshot() {
    if (!snapshot) return
    setExportError('')
    const content = JSON.stringify(snapshot, null, 2)
    if (isDesktopRuntime()) {
      try {
        await saveTextFile({ dialogTitle: t('developer.clipboard.export'), defaultFilename: 'kition-clipboard.json', content })
      } catch {
        setExportError(t('common.saveFailed'))
      }
      return
    }
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'kition-clipboard.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <SettingsSection title={t('developer.clipboard.title')} description={t('developer.clipboard.description')}>
      <div className="space-y-4 p-4" data-testid="clipboard-inspector">
        <label className="block space-y-2 text-sm">
          <span>{t('developer.clipboard.pasteLabel')}</span>
          <textarea
            className="min-h-24 w-full rounded-lg border border-input bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('developer.clipboard.pasteLabel')}
            placeholder={t('developer.clipboard.placeholder')}
            value=""
            onChange={() => undefined}
            onPaste={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!tools) return
              const next = tools.inspectDocumentClipboard(event.clipboardData)
              setSnapshot(next)
              setSelectedType(next.types.includes('text/html') ? 'text/html' : next.types.find((type) => type !== 'Files') || '')
              setShowPreview(false)
              setExportError('')
            }}
          />
        </label>
        <p className="text-xs text-muted-foreground">{t('developer.clipboard.privacy')}</p>
        {snapshot ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void exportSnapshot()}>{t('developer.clipboard.export')}</Button>
              <Button size="sm" variant="outline" onClick={() => { setSnapshot(null); setShowPreview(false); setExportError('') }}>
                {t('developer.clipboard.clear')}
              </Button>
            </div>
            {exportError ? <p role="alert" className="text-sm text-destructive">{exportError}</p> : null}
            <p role="status" className="text-sm">{t('developer.clipboard.detected', { types: snapshot.types.join(', ') || t('developer.clipboard.none') })}</p>
            <label className="block space-y-2 text-sm">
              <span>{t('developer.clipboard.raw')}</span>
              <select className="ml-2 max-w-full rounded-lg border border-input bg-background p-2" value={selectedType} onChange={(event) => setSelectedType(event.target.value)}>
                {Object.keys(snapshot.payloads).map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <textarea aria-label={t('developer.clipboard.raw')} readOnly value={snapshot.payloads[selectedType] || ''} className="h-48 w-full rounded-lg border border-input bg-background p-3 font-mono text-xs" />
            </label>
            <label className="block space-y-2 text-sm">
              <span>{t('developer.clipboard.converted', { format: snapshot.documentConversion.format })}</span>
              <textarea aria-label={t('developer.clipboard.markdown')} readOnly value={snapshot.documentConversion.markdown} className="h-48 w-full rounded-lg border border-input bg-background p-3 font-mono text-xs" />
            </label>
            <p className="text-xs text-muted-foreground">{t('developer.clipboard.conversionNote')}</p>
            <details>
              <summary className="cursor-pointer text-sm">{t('developer.clipboard.metadata')}</summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all p-3 text-xs">{JSON.stringify({ items: snapshot.items, files: snapshot.files }, null, 2)}</pre>
            </details>
            {snapshot.payloads['text/html'] ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setShowPreview((value) => !value)} aria-expanded={showPreview}>
                  {t('developer.clipboard.preview')}
                </Button>
                {showPreview ? <iframe
                  title={t('developer.clipboard.preview')}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  className="h-64 w-full rounded-xl border border-border bg-white"
                  srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${tools?.clipboardHtmlPreview(snapshot.payloads['text/html']) ?? ''}</body></html>`}
                /> : null}
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </SettingsSection>
  )
}
