import { useEffect } from 'react'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n'

type Props = {
  providerName: string
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  pending?: boolean
  error?: string
}

export function DisconnectConfirmDialog({ providerName, onCancel, onConfirm, pending, error }: Props) {
  const { t } = useTranslation('settings')
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => { window.removeEventListener('keydown', handler, true) }
  }, [onCancel])

  return (
    <div className="settings-modal-stage" onClick={onCancel}>
      <div className="disconnect-dialog" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('disconnectDialog.title', { provider: providerName })}</h3>
        <p>{t('disconnectDialog.body')}</p>
        {error ? <p className="disconnect-dialog-error" role="alert">{error}</p> : null}
        <div className="disconnect-dialog-actions">
          <Button variant="outline" onClick={onCancel} disabled={pending}>{t('disconnectDialog.cancel')}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? t('disconnectDialog.disconnecting') : t('disconnectDialog.disconnect')}
          </Button>
        </div>
      </div>
    </div>
  )
}
