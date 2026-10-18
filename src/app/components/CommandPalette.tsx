import { Command, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@kition/app-ui'
import { useExtensionPaletteItems } from '@/features/extensions/public'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function CommandPalette({
  onClose,
  onOpenSettings,
  onOpenShared,
}: {
  onClose: () => void
  onOpenSettings: () => void
  /** Opens a document someone shared for co-editing; absent when co-editing is off. */
  onOpenShared?: () => void
}) {
  const { t } = useTranslation('common')
  const actions = useMemo(
    () => [
      {
        title: t('commandPalette.backToWorkspace'),
        action: 'workspace',
        hint: t('commandPalette.backToWorkspaceHint'),
      },
      {
        title: t('commandPalette.openSettings'),
        action: 'settings',
        hint: t('commandPalette.openSettingsHint'),
      },
      ...(onOpenShared
        ? [
            {
              title: t('commandPalette.openShared'),
              action: 'open-shared',
              hint: t('commandPalette.openSharedHint'),
            },
          ]
        : []),
    ],
    [onOpenShared, t],
  )
  // Commands of extensions for the kit document shown now, and Run script.
  const extensionItems = useExtensionPaletteItems({ runScript: t('commandPalette.runScript'), runScriptHint: t('commandPalette.runScriptHint') })
  const items = useMemo(
    () => [
      ...actions.map((item) => ({ key: item.action, title: item.title, hint: item.hint, group: 'navigation', run: () => open(item.action) })),
      ...extensionItems.map((item) => ({
        ...item,
        group: 'extensions',
        run: () => {
          onClose()
          item.run()
        },
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, extensionItems],
  )
  const [cursor, setCursor] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function open(action: string) {
    if (action === 'settings') {
      onOpenSettings()
    }
    if (action === 'open-shared') {
      onOpenShared?.()
    }
    onClose()
  }

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    inputRef.current?.focus()
    return () => {
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus?.()
    }
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Tab') {
        const panel = panelRef.current
        if (!panel) return
        const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        if (event.shiftKey) {
          if (active === first || !panel.contains(active)) {
            event.preventDefault()
            last.focus()
          }
        } else if (active === last || !panel.contains(active)) {
          event.preventDefault()
          first.focus()
        }
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor((c) => Math.min(c + 1, items.length - 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor((c) => Math.max(c - 1, 0))
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        items[cursor]?.run()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cursor, onClose])

  return (
    <div className="command-overlay" role="presentation" onClick={onClose}>
      <div
        className="command-panel"
        data-testid="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('commandPalette.badge')}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-4 py-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent-foreground">
            <Command className="size-3" /> {t('commandPalette.badge')}
          </span>
          <span className="text-[11px] text-muted-foreground" title={t('commandPalette.shortcuts')}>
            ⌘K · ⌘. · {t('commandPalette.hint')}
          </span>
        </header>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Command className="size-4 text-muted-foreground" />
          <input
            ref={inputRef}
            className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder={t('commandPalette.placeholder')}
            data-testid="command-palette-input"
          />
          <Button variant="ghost" size="icon" aria-label={t('commandPalette.close')} onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="p-2">
          {(['navigation', 'extensions'] as const).map((group) => {
            const rows = items.map((item, index) => ({ item, index })).filter(({ item }) => item.group === group)
            if (!rows.length) return null
            return (
              <div key={group} role="group" aria-label={t(`commandPalette.${group}`)} data-testid={`command-palette-group-${group}`}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`commandPalette.${group}`)}
                </div>
                {rows.map(({ item, index }) => (
                  <button
                    key={item.key}
                    data-testid="command-palette-row"
                    data-command={item.key}
                    aria-selected={index === cursor}
                    className={
                      'flex w-full items-center justify-between rounded-md px-3 py-3 text-left hover:bg-muted' +
                      (index === cursor ? ' bg-muted' : '')
                    }
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => item.run()}
                  >
                    <span>
                      <strong className="block text-sm">{item.title}</strong>
                      <small className="text-muted-foreground">{item.hint}</small>
                    </span>
                    <span className="text-xs text-muted-foreground">Enter</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
