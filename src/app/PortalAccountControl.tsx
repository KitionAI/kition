import { useEffect } from 'react'
import { X } from 'lucide-react'

import { KitionAccountPanel } from '@/features/account/components/KitionAccountPanel'

export { KitionAccountPanel as PortalProfilePage }

export function PortalProfileDialog({ onClose }: { onClose: () => void }) {
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
    <div className="portal-profile-modal-stage" onClick={onClose}>
      <div
        className="portal-profile-modal-window"
        role="dialog"
        aria-modal="true"
        aria-label="Account info"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="portal-profile-modal-close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <X className="size-4" />
        </button>
        <KitionAccountPanel />
      </div>
    </div>
  )
}
