import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { BrowserSessionPanelState } from '@/services/desktop'

export const WORKSPACE_BROWSER_TOOLBAR_HEIGHT = 48

type WorkspaceBrowserToolbarProps = {
  status: Pick<
    BrowserSessionPanelState,
    'url' | 'canGoBack' | 'canGoForward' | 'isLoading'
  >
  onNavigate: (address: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
}

export function WorkspaceBrowserToolbar({
  status,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
}: WorkspaceBrowserToolbarProps) {
  const { t } = useTranslation('workspace')
  const liveURL = status.url || ''
  const isLoading = Boolean(status.isLoading)
  const canGoBack = Boolean(status.canGoBack)
  const canGoForward = Boolean(status.canGoForward)

  const [address, setAddress] = useState(liveURL)
  const [focused, setFocused] = useState(false)

  // Keep the address bar mirroring the live page URL, but never clobber text the
  // user is actively typing.
  useEffect(() => {
    if (!focused) {
      setAddress(liveURL)
    }
  }, [liveURL, focused])

  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const raw = address.trim()
    if (!raw) {
      return
    }
    inputRef.current?.blur()
    onNavigate(raw)
  }

  return (
    <div
      className="workspace-browser-toolbar"
      style={{ height: WORKSPACE_BROWSER_TOOLBAR_HEIGHT }}
    >
      <div className="workspace-browser-toolbar__nav">
        <button
          type="button"
          className="workspace-browser-toolbar__icon-button"
          aria-label={t('browserToolbar.back')}
          disabled={!canGoBack}
          onClick={onBack}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="workspace-browser-toolbar__icon-button"
          aria-label={t('browserToolbar.forward')}
          disabled={!canGoForward}
          onClick={onForward}
        >
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="workspace-browser-toolbar__icon-button"
          aria-label={isLoading ? t('browserToolbar.stopLoading') : t('browserToolbar.reload')}
          onClick={isLoading ? onStop : onReload}
        >
          {isLoading ? (
            <X className="size-4" aria-hidden="true" />
          ) : (
            <RotateCw className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      <form
        className={cn(
          'workspace-browser-toolbar__address',
          focused && 'workspace-browser-toolbar__address--focused',
        )}
        onSubmit={handleSubmit}
      >
        <input
          ref={inputRef}
          className="workspace-browser-toolbar__input"
          type="text"
          value={address}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={t('browserToolbar.addressPlaceholder')}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => {
            setFocused(true)
            event.target.select()
          }}
          onBlur={() => {
            setFocused(false)
            setAddress(liveURL)
          }}
        />
        {isLoading ? (
          <span
            className="workspace-browser-toolbar__spinner"
            aria-hidden="true"
          />
        ) : null}
      </form>
    </div>
  )
}
