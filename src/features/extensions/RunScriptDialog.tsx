import { useEffect, useState } from 'react'
import { LoaderCircleIcon as LoaderCircle } from '@kition/tessera-icons/react'
import { useTranslation } from 'react-i18next'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle, TextInput } from '@kition/tessera-ui'
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
    <Modal open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <ModalContent size="sm" className="gap-0 p-0" data-testid="run-script-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (path.trim() && !busy) void run()
          }}
        >
          <ModalHeader className="space-y-2 border-b px-5 py-4">
            <ModalTitle>{t('extensions.runScript.title')}</ModalTitle>
            <ModalDescription>{t('extensions.runScript.description', { document: name })}</ModalDescription>
          </ModalHeader>
          <div className="px-5 py-4">
            <TextInput size="lg"
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
          <ModalFooter className="border-t px-5 py-4">
            <Button size="md" type="button" variant="secondary" onClick={onClose} disabled={busy}>
              {t('extensions.runScript.cancel')}
            </Button>
            <Button size="md" variant="primary" type="submit" disabled={busy || !path.trim() || !document} data-testid="run-script-run">
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {t('extensions.runScript.run')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
