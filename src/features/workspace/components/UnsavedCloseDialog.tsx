import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kition/tessera-ui'

/** What the person chose for a tab or the window closed with unsaved edits. */
export type UnsavedCloseChoice = 'save' | 'discard' | 'cancel'

/** What is closing: one tab (`names` its document), or the window with every open document. */
export type UnsavedCloseScope = { kind: 'tab'; names: [string] } | { kind: 'window'; names: string[] }

type Asking = { scope: UnsavedCloseScope; resolve: (choice: UnsavedCloseChoice) => void }

/**
 * Asks before a tab or the window with unsaved edits closes: save them, close without them, or
 * keep it open. `ask(scope)` resolves with the choice; `dialog` is rendered once by the screen
 * that closes them. Escape, an outside press, and a second ask while one is open count as cancel.
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

  const ask = useCallback((scope: UnsavedCloseScope) => {
    if (current.current) return Promise.resolve<UnsavedCloseChoice>('cancel')
    return new Promise<UnsavedCloseChoice>((resolve) => {
      current.current = { scope, resolve }
      setAsking(current.current)
    })
  }, [])

  // A screen that unmounts with the question open keeps what was closing.
  useEffect(() => () => current.current?.resolve('cancel'), [])

  return { ask, dialog: <UnsavedCloseDialog asking={asking} onSettle={settle} /> }
}

function UnsavedCloseDialog({ asking, onSettle }: { asking: Asking | null; onSettle: (choice: UnsavedCloseChoice) => void }) {
  const { t } = useTranslation('workspace')
  const names = asking?.scope.names ?? []
  const title = names.length === 1 ? t('tabs.unsavedTitle', { name: names[0] }) : t('tabs.unsavedTitleMany', { count: names.length })
  const message = asking?.scope.kind === 'window' ? t('tabs.unsavedWindowMessage') : t('tabs.unsavedMessage')
  return (
    <Modal open={asking !== null} onOpenChange={(open) => (open ? undefined : onSettle('cancel'))}>
      <ModalContent hideClose size="sm" data-testid="unsaved-close">
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          <ModalDescription>{message}</ModalDescription>
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
