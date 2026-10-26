import { LoaderCircleIcon as LoaderCircle } from '@kition/tessera-icons/react'
import { useTranslation } from 'react-i18next'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle, TextInput } from '@kition/tessera-ui'

export function WorkspaceFolderCreateDialog({
  open,
  value,
  busy,
  onOpenChange,
  onValueChange,
  onSubmit,
}: {
  open: boolean
  value: string
  busy: boolean
  onOpenChange: (open: boolean) => void
  onValueChange: (value: string) => void
  onSubmit: () => void
}) {
  const { t } = useTranslation('workspace')
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="sm" className="gap-0 p-0">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <ModalHeader className="space-y-2 border-b px-5 py-4">
            <ModalTitle>{t('folderDialog.title')}</ModalTitle>
            <ModalDescription>{t('folderDialog.description')}</ModalDescription>
          </ModalHeader>
          <div className="px-5 py-4">
            <TextInput size="lg"
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              placeholder={t('folderDialog.placeholder')}
              autoFocus
              disabled={busy}
            />
          </div>
          <ModalFooter className="border-t px-5 py-4">
            <Button size="md"
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {t('folderDialog.cancel')}
            </Button>
            <Button size="md" variant="primary" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {t('folderDialog.create')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
