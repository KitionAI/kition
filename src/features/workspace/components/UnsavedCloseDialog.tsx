import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kition/tessera-ui'

/** What the person chose for a tab closed with unsaved edits. */
export type UnsavedCloseChoice = 'save' | 'discard' | 'cancel'

type Asking = { title: string; resolve: (choice: UnsavedCloseChoice) => void }

/**
 * Asks before a tab with unsaved edits closes: save them, close without them, or keep the tab.
 * `ask(title)` resolves with the choice; `dialog` is rendered once by the screen that closes tabs.
 * Escape, an outside press, and a second ask while one is open count as cancel.
 */
export function useUnsavedCloseQuestion() {
  const [asking, setAsking] = useState<Asking | null>(null)
  const current = useRef<Asking | null>(null)

  const settle = useCallback((choice: UnsavedCloseChoice) => {
    const open = current.current
    current.current = null
    setAsking(null)
    open?.resolve(choice)
  }, [])

  const ask = useCallback((title: string) => {
    if (current.current) return Promise.resolve<UnsavedCloseChoice>('cancel')
    return new Promise<UnsavedCloseChoice>((resolve) => {
      current.current = { title, resolve }
      setAsking(current.current)
    })
  }, [])

  // A screen that unmounts with the question open keeps its tab.
  useEffect(() => () => current.current?.resolve('cancel'), [])

  return { ask, dialog: <UnsavedCloseDialog asking={asking} onSettle={settle} /> }
}

function UnsavedCloseDialog({ asking, onSettle }: { asking: Asking | null; onSettle: (choice: UnsavedCloseChoice) => void }) {
  const { t } = useTranslation('workspace')
  return (
    <Modal open={asking !== null} onOpenChange={(open) => (open ? undefined : onSettle('cancel'))}>
      <ModalContent hideClose size="sm" data-testid="unsaved-close">
        <ModalHeader>
          <ModalTitle>{t('tabs.unsavedTitle', { name: asking?.title ?? '' })}</ModalTitle>
          <ModalDescription>{t('tabs.unsavedMessage')}</ModalDescription>
        </ModalHeader>
        <ModalFooter>
          <Button variant="secondary" size="md" onClick={() => onSettle('discard')} data-testid="unsaved-close-discard">
            {t('tabs.unsavedDiscard')}
          </Button>
          <Button variant="secondary" size="md" onClick={() => onSettle('cancel')} data-testid="unsaved-close-cancel">
            {t('tabs.unsavedCancel')}
          </Button>
          <Button variant="primary" size="md" onClick={() => onSettle('save')} data-testid="unsaved-close-save">
            {t('tabs.unsavedSave')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
