import { useEffect } from 'react'
import { useDialogFocus } from '@/lib/useDialogFocus'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { KitionAccountPanel } from '@/features/account/components/KitionAccountPanel'

export { KitionAccountPanel as PortalProfilePage }

export function PortalProfileDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>()
  const { t } = useTranslation('common')
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="portal-profile-modal-stage" role="presentation" onClick={onClose}>
      <div
        className="portal-profile-modal-window"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('dialogs.accountInfo')}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="portal-profile-modal-close"
          onClick={onClose}
          aria-label={t('actions.close')}
          title={t('actions.close')}
        >
          <X className="size-4" />
        </button>
        <KitionAccountPanel />
      </div>
    </div>
  )
}
