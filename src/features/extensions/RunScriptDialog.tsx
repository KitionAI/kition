import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '@kition/app-ui'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@kition/app-ui/dialog'
import type { ExtensionService } from './extensionService'
import { loadExtensionService } from './serviceLoader'

/**
 * Runs a workspace `.mjs` script against the kit document shown now, sandboxed like an extension,
 * with model.read, model.write, and commands.run.
 */
export default function RunScriptDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('common')
  const [service, setService] = useState<ExtensionService | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void loadExtensionService().then((loaded) => {
      if (live) setService(loaded)
    })
    return () => {
      live = false
    }
  }, [])
  const document = service?.activeDocument() ?? null
  const name = document?.path.split('/').pop() ?? ''

  const run = async () => {
    if (!service) return
    setBusy(true)
    const ok = await service.runScript(path)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent size="sm" className="gap-0 p-0" data-testid="run-script-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (path.trim() && !busy) void run()
          }}
        >
          <DialogHeader className="space-y-2 border-b px-5 py-4">
            <DialogTitle>{t('extensions.runScript.title')}</DialogTitle>
            <DialogDescription>{t('extensions.runScript.description', { document: name })}</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-4">
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={t('extensions.runScript.placeholder')}
              aria-label={t('extensions.runScript.pathLabel')}
              autoFocus
              spellCheck={false}
              disabled={busy}
              data-testid="run-script-path"
            />
          </div>
          <DialogFooter className="border-t px-5 py-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('extensions.runScript.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !path.trim() || !document} data-testid="run-script-run">
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {t('extensions.runScript.run')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
