import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  MoreHorizontal,
  RefreshCw,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { KitionLogoMark } from '@/components/KitionLogoMark'
import { Button, Card, CardContent, Input } from '@/components/ui'
import { useConfirm } from '@/components/confirm'
import { useDismissableLayer } from '@/registry/hooks/use-on-click-outside'
import { cn } from '@/lib/utils'
import type { VaultEntry } from '@/services/desktop'

type WorkspaceLauncherScreenProps = {
  variant?: 'fullscreen' | 'dialog'
  vaults: VaultEntry[]
  activeVaultPath: string
  appVersion?: string
  loaded: boolean
  error?: string
  busy?: boolean
  onSelectVault: (path: string) => Promise<void> | void
  onOpenLocalVault: () => Promise<void> | void
  onRenameVault: (path: string, name: string) => Promise<void> | void
  onRemoveVault: (path: string) => Promise<void> | void
  onClose?: () => void
}

function getVaultDirname(vaultPath: string) {
  const segments = String(vaultPath || '').split(/[\\/]+/).filter(Boolean)
  return segments[segments.length - 1] || vaultPath
}

function getVaultParent(vaultPath: string) {
  const normalized = String(vaultPath || '').replace(/[\\/]+$/, '')
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSlash <= 0) {
    return normalized
  }
  return normalized.slice(0, lastSlash)
}

export function WorkspaceLauncherScreen({
  variant = 'fullscreen',
  vaults,
  activeVaultPath,
  appVersion,
  loaded,
  error,
  busy,
  onSelectVault,
  onOpenLocalVault,
  onRenameVault,
  onRemoveVault,
  onClose,
}: WorkspaceLauncherScreenProps) {
  const { t } = useTranslation('workspaceLauncher')
  const confirm = useConfirm()
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<VaultEntry | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [actionError, setActionError] = useState('')
  const [working, setWorking] = useState(false)

  const closeMenu = () => setOpenMenuPath(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useDismissableLayer(menuRef, Boolean(openMenuPath), closeMenu)

  const renameRef = useRef<HTMLDivElement | null>(null)
  useDismissableLayer(renameRef, Boolean(renameTarget), () => setRenameTarget(null))

  useEffect(() => {
    if (renameTarget) {
      setRenameDraft(renameTarget.name || getVaultDirname(renameTarget.path))
    }
  }, [renameTarget])

  const sortedVaults = useMemo(() => {
    return [...vaults]
  }, [vaults])

  const runAction = async (factory: () => Promise<void> | void) => {
    setWorking(true)
    setActionError('')
    try {
      await factory()
    } catch (requestError: any) {
      setActionError(requestError?.message || 'Operation failed')
    } finally {
      setWorking(false)
    }
  }

  const handlePickVault = (vaultPath: string) =>
    runAction(async () => {
      await onSelectVault(vaultPath)
    })

  const handleOpenLocal = () =>
    runAction(async () => {
      await onOpenLocalVault()
    })

  const handleRenameSubmit = () =>
    runAction(async () => {
      if (!renameTarget) {
        return
      }
      const next = renameDraft.trim()
      if (!next) {
        throw new Error(t('errors.missingName'))
      }
      await onRenameVault(renameTarget.path, next)
      setRenameTarget(null)
    })

  const handleRemove = (vaultPath: string) =>
    runAction(async () => {
      if (!(await confirm({ message: t('vault.removeConfirm'), variant: 'destructive' }))) {
        return
      }
      await onRemoveVault(vaultPath)
      closeMenu()
    })

  const wrapperClass = variant === 'fullscreen'
    ? 'fixed inset-0 z-40 flex bg-background'
    : 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6'

  const cardClass = variant === 'fullscreen'
    ? 'flex h-full w-full overflow-hidden'
    : 'flex h-[min(720px,90vh)] w-[min(960px,92vw)] overflow-hidden rounded-xl border border-border bg-background shadow-soft'

  const isBusy = Boolean(busy || working)

  return (
    <div className={wrapperClass} data-testid="workspace-launcher">
      <div className={cardClass}>
        <aside className="flex w-[300px] flex-col border-r border-border bg-sidebar p-4 text-sidebar-foreground">
          <div className="flex items-center justify-between pb-3">
            <span className="text-sm font-medium text-foreground">{t('title')}</span>
            {variant === 'dialog' && onClose ? (
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
          <div className="-mx-1 flex-1 overflow-y-auto">
            {!loaded ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                <RefreshCw className="size-3 animate-spin" /> Loading…
              </div>
            ) : sortedVaults.length === 0 ? (
              <p className="px-2 py-6 text-xs text-muted-foreground">{t('vault.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {sortedVaults.map((vault) => {
                  const isActive = vault.path === activeVaultPath
                  return (
                    <li key={vault.path} className="relative">
                      <button
                        type="button"
                        onClick={() => handlePickVault(vault.path)}
                        disabled={isBusy}
                        className={cn(
                          'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition hover:bg-sidebar-accent',
                          isActive ? 'bg-sidebar-accent text-foreground' : 'text-sidebar-foreground',
                        )}
                      >
                        <span className="flex-1 truncate">
                          <span className="block truncate font-medium">{vault.name || getVaultDirname(vault.path)}</span>
                          <span className="block truncate text-xs text-muted-foreground">{vault.path}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setOpenMenuPath(openMenuPath === vault.path ? null : vault.path)
                        }}
                        className="absolute right-1 top-1.5 hidden rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground group-hover:inline-flex"
                        aria-label="More"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                      {openMenuPath === vault.path ? (
                        <div
                          ref={menuRef}
                          className="absolute right-1 top-9 z-10 min-w-[160px] rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-floating"
                        >
                          <button
                            type="button"
                            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                            onClick={() => {
                              setOpenMenuPath(null)
                              setRenameTarget(vault)
                            }}
                          >
                            {t('vault.menu.rename')}
                          </button>
                          <button
                            type="button"
                            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                            onClick={() => handleRemove(vault.path)}
                          >
                            {t('vault.menu.remove')}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </aside>

        <section className="flex flex-1 flex-col items-center justify-center bg-background px-12 py-10 text-foreground">
          <div className="flex flex-col items-center pb-8 text-center">
            <KitionLogoMark className="size-20" />
            <h1 className="mt-4 text-3xl font-semibold text-foreground">Kition</h1>
            {appVersion ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('subtitle', { version: appVersion })}</p>
            ) : null}
          </div>

          <Card className="w-full max-w-[480px] border border-border bg-card text-card-foreground shadow-soft">
            <CardContent className="p-0">
              <LauncherAction
                title={t('actions.open.title')}
                description={t('actions.open.description')}
              >
                <Button
                  type="button"
                  variant="secondary"
                  disabled={isBusy}
                  onClick={handleOpenLocal}
                >
                  {t('actions.open.button')}
                </Button>
              </LauncherAction>
            </CardContent>
          </Card>

          {actionError || error ? (
            <p className="mt-4 max-w-[480px] text-center text-xs text-destructive">{actionError || error}</p>
          ) : null}
        </section>

        {renameTarget ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6" role="dialog">
            <div
              ref={renameRef}
              className="w-full max-w-[400px] rounded-xl border border-border bg-card p-5 text-card-foreground shadow-floating"
            >
              <h2 className="text-base font-medium text-foreground">{t('vault.renameTitle')}</h2>
              <p className="mt-1 truncate text-xs text-muted-foreground">{renameTarget.path}</p>
              <Input
                autoFocus
                className="mt-3"
                placeholder={t('vault.renamePlaceholder')}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
              />
              {actionError ? (
                <p className="mt-3 text-xs text-destructive">{actionError}</p>
              ) : null}
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" type="button" onClick={() => setRenameTarget(null)} disabled={isBusy}>
                  {t('actions.create.cancel')}
                </Button>
                <Button
                  type="button"
                  className="bg-brand text-brand-foreground hover:bg-brand/90"
                  onClick={handleRenameSubmit}
                  disabled={isBusy}
                >
                  {t('vault.menu.rename')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LauncherAction({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// Quiet unused warnings for icons reserved for future menu items
void ChevronDown
void getVaultParent
