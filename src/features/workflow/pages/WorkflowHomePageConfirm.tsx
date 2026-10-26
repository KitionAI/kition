import { useTranslation } from 'react-i18next'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kition/tessera-ui'

/**
 * ConfirmDialog + ConfirmState — split out of WorkflowHomePage (WF-C1c).
 *
 * Drives every destructive / confirmation flow on the page (delete
 * workflow, switch trigger table with dangling field refs, discard
 * unsaved changes). State stays on the page; this component just renders
 * whatever's in the bag.
 *
 * `destructive: true` tints the primary button red (the delete affordance);
 * everything else uses the brand purple. `onConfirm` runs AFTER `onClose`
 * so the dialog has fully unmounted before any state mutation — without
 * that ordering, a Save inside onConfirm would race the Modal's
 * onOpenChange teardown and cause a "tree contains forwardRef" warning.
 */

export type ConfirmState = {
  title: string
  message: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmState | null
  onClose: () => void
}) {
  const { t } = useTranslation('workflow')
  const open = state !== null
  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <ModalContent size="sm" data-testid="workflow-home-confirm">
        <ModalHeader>
          <ModalTitle>{state?.title || ''}</ModalTitle>
          <ModalDescription>{state?.message || ''}</ModalDescription>
        </ModalHeader>
        <ModalFooter>
          <Button size="sm" variant="secondary" onClick={onClose} data-testid="workflow-home-confirm-cancel">{t('confirms.cancel')}</Button>
          <Button size="sm" variant="primary"
            className={state?.destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'bg-primary hover:bg-primary/90'}
            onClick={() => {
              const fn = state?.onConfirm
              onClose()
              fn?.()
            }}
            data-testid="workflow-home-confirm-ok"
          >
            {state?.confirmLabel || t('confirms.fallbackLabel')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
