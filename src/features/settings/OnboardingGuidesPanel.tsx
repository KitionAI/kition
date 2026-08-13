import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Card, CardContent } from '@/components/ui'
import { listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'
import {
  onboardingGuideFolderExists,
  useImportOnboardingGuides,
  type OnboardingGuideManifest,
} from './useImportOnboardingGuides'
import { Download, FolderCheck, Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { SettingsPaneHeader } from './primitives'
import { ONBOARDING_GUIDE_MANIFEST_URL } from '@/features/onboarding/onboardingGuideManifest'
import { readBundledAssetText } from '@/lib/bundledAssets'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; manifest: OnboardingGuideManifest; items: WorkspaceDocumentTreeItem[]; rootPath: string }

export function OnboardingGuidesPanel({ onClose }: { onClose?: () => void } = {}) {
  const { t } = useTranslation('settings')
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const [manifest, ws] = await Promise.all([
        readBundledAssetText(ONBOARDING_GUIDE_MANIFEST_URL)
          .then((text) => JSON.parse(text) as OnboardingGuideManifest),
        listWorkspaceDocuments(),
      ])
      setState({ kind: 'ready', manifest, items: ws.items, rootPath: ws.root_path })
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message || 'load failed' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!onClose) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => { window.removeEventListener('keydown', handler, true) }
  }, [onClose])

  const refreshWorkspace = useCallback(async () => {
    const ws = await listWorkspaceDocuments()
    setState((prev) => prev.kind === 'ready' ? { ...prev, items: ws.items, rootPath: ws.root_path } : prev)
  }, [])

  let content: ReactNode
  if (state.kind === 'loading') {
    content = (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('onboardingGuides.loadingManifest')}
      </div>
    )
  } else if (state.kind === 'error') {
    content = (
      <div className="space-y-3">
        <p className="text-sm text-red-600">{t('onboardingGuides.loadFailed', { message: state.message })}</p>
        <Button onClick={() => void load()} size="sm" variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" /> {t('onboardingGuides.retry')}
        </Button>
      </div>
    )
  } else {
    content = <OnboardingGuidesPanelReady state={state} refreshWorkspace={refreshWorkspace} reload={load} />
  }

  if (onClose) {
    return (
      <div className="settings-modal-stage" onClick={onClose}>
        <section
          className="settings-modal-window"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={t('onboardingGuides.modalLabel')}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label={t('onboardingGuides.close')}
            className="settings-modal-close"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="p-6">
            {content}
          </div>
        </section>
      </div>
    )
  }

  return <>{content}</>
}

function OnboardingGuidesPanelReady(props: {
  state: Extract<LoadState, { kind: 'ready' }>
  refreshWorkspace: () => Promise<void>
  reload: () => Promise<void>
}) {
  const { state, refreshWorkspace } = props
  const { t } = useTranslation('settings')
  const { status, importSingle, importAll } = useImportOnboardingGuides(
    state.manifest, state.items, refreshWorkspace,
  )

  const noWorkspace = !state.rootPath
  const busy = status.kind === 'running'

  return (
    <div className="settings-pane">
      <SettingsPaneHeader
        title={t('onboardingGuides.paneTitle')}
        description={t('onboardingGuides.paneDescription')}
      />

      {noWorkspace ? (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t('onboardingGuides.needWorkspace')}
        </div>
      ) : null}

      {status.kind === 'running' ? (
        <div className="mb-3 text-xs text-muted-foreground">
          {status.finished} / {status.total} · {status.current}
        </div>
      ) : null}
      {status.kind === 'error' ? (
        <div className="mb-3 text-sm text-red-600">{t('onboardingGuides.importFailed', { message: status.message })}</div>
      ) : null}
      {status.kind === 'partial' ? (
        <div className="mb-3 text-sm text-amber-700">
          {t('onboardingGuides.importPartial', {
            done: status.finishedSlugs.length,
            total: status.finishedSlugs.length + status.failedSlugs.length,
            failed: status.failedSlugs.join(', '),
          })}
        </div>
      ) : null}

      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('onboardingGuides.guides')}
        </span>
        <Button
          onClick={() => void importAll()}
          disabled={noWorkspace || busy}
          size="sm"
        >
          {busy
            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('onboardingGuides.importing')}</>
            : <><Sparkles className="mr-2 h-4 w-4" /> {t('onboardingGuides.importAll')}</>}
        </Button>
      </div>

      <div className="grid gap-3">
        {state.manifest.guides.map((guide) => {
          const installed = onboardingGuideFolderExists(state.items, guide.displayName)
          const disabled = noWorkspace || busy
          return (
            <Card key={guide.slug}>
              <CardContent className="flex items-start justify-between gap-3 p-5">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{guide.displayName}</span>
                    {installed ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                        <FolderCheck className="h-3 w-3" /> {t('onboardingGuides.imported')}
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {t('onboardingGuides.notImported')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{guide.summary}</p>
                </div>
                <Button
                  onClick={() => void importSingle(guide.slug)}
                  disabled={disabled || installed}
                  size="sm"
                  variant={installed ? 'outline' : 'default'}
                >
                  {installed
                    ? t('onboardingGuides.imported')
                    : <><Download className="mr-2 h-4 w-4" /> {t('onboardingGuides.import')}</>}
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
