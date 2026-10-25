import { AppWindowIcon as AppWindow, ArrowRightLeftIcon as ArrowRightLeft, LoaderCircleIcon as LoaderCircle } from '@kition/tessera-icons/react'
import { useTranslation } from 'react-i18next'

import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kition/tessera'

type WorkspaceOpenModeDialogProps = {
  open: boolean
  workspaceName: string
  workspacePath: string
  busy?: boolean
  errorMessage?: string
  onOpenChange: (open: boolean) => void
  onOpenCurrent: () => void
  onOpenNew: () => void
}

export function WorkspaceOpenModeDialog({
  open,
  workspaceName,
  workspacePath,
  busy = false,
  errorMessage = '',
  onOpenChange,
  onOpenCurrent,
  onOpenNew,
}: WorkspaceOpenModeDialogProps) {
  const { t } = useTranslation('workspaceLauncher')

  return (
    <Modal open={open} onOpenChange={(next) => (busy ? null : onOpenChange(next))}>
      <ModalContent
        size="lg"
        className="gap-0 overflow-hidden p-0"
        data-testid="workspace-open-mode-dialog"
      >
        <ModalHeader className="space-y-2 border-b px-6 py-5">
          <ModalTitle>{t('openMode.title', { name: workspaceName })}</ModalTitle>
          <ModalDescription>{t('openMode.description')}</ModalDescription>
          <p className="truncate text-xs text-muted-foreground" title={workspacePath}>
            {workspacePath}
          </p>
        </ModalHeader>

        <div className="grid gap-3 px-6 py-5 sm:grid-cols-2">
          <div className="flex min-h-44 flex-col rounded-xl border border-border bg-card p-4 text-card-foreground shadow-soft">
            <div className="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
              <ArrowRightLeft className="size-4" />
            </div>
            <div className="mt-4 flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t('openMode.current.title')}</h3>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                {t('openMode.current.description')}
              </p>
            </div>
            <Button size="md"
              type="button"
              variant="secondary"
              className="mt-4 w-full"
              disabled={busy}
              onClick={onOpenCurrent}
              data-testid="workspace-open-current"
            >
              {t('openMode.current.button')}
            </Button>
          </div>

          <div className="flex min-h-44 flex-col rounded-xl border border-ring/40 bg-accent/40 p-4 text-card-foreground shadow-soft">
            <div className="flex size-9 items-center justify-center rounded-lg bg-brand text-brand-foreground">
              <AppWindow className="size-4" />
            </div>
            <div className="mt-4 flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t('openMode.new.title')}</h3>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                {t('openMode.new.description')}
              </p>
            </div>
            <Button size="md"
              type="button"
              variant="primary"
              className="mt-4 w-full"
              disabled={busy}
              onClick={onOpenNew}
              data-testid="workspace-open-new"
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {t('openMode.new.button')}
            </Button>
          </div>
        </div>

        {errorMessage ? (
          <p className="px-6 pb-4 text-sm text-destructive" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <ModalFooter className="border-t px-6 py-4">
          <Button size="md"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('openMode.cancel')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
