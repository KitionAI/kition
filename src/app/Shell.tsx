import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Menu, X } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { ConfirmProvider } from '@/components/confirm'
import { ConsoleCreditsExhaustedBanner } from '@/app/ConsoleCreditsExhaustedBanner'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import type { SettingsSectionKey } from '@/features/settings/DesktopSettingsPage'
import { useGlobalShortcuts } from '@/features/settings/useGlobalShortcuts'
import { WorkspaceScreen } from '@/features/workspace/components/WorkspaceScreen'
import { WorkspaceLauncherScreen } from '@/features/workspace/components/WorkspaceLauncherScreen'
import { useWorkspaceVaults } from '@/features/workspace/hooks/useWorkspaceVaults'
import { cn } from '@/lib/utils'
import { isWebPreviewMode } from '@/lib/runtimeMode'
import { handleDesktopChromeDoubleClick } from '@/lib/windowChrome'
import { useMediaQuery } from '@/registry/hooks/use-media-query'
import { getDesktopBackendStatus, getDesktopInfo, resolveApiURL } from '@/services/desktop'
import { restorePortalAccountSession } from '@/services/portalAccount'
import { SearchService } from '@/features/search/service/searchService'
import { attachEventBridges } from '@/features/search/service/events'
import { scheduleSearchBoot } from '@/features/search/service/searchBootScheduler'
import { loadVaultMarkdownFiles } from '@/features/document/editor/vault/vault-files'
import { vaultClient } from '@/features/document/editor/vault/vault-client'
import { extractNoteDocs } from '@/features/search/sources/noteSource'
import type { NavigateAdapters } from '@/features/search/ui/navigateToHit'
import { navigateToHit } from '@/features/search/ui/navigateToHit'
import { maybeSeedOnboardingPack } from '@/features/onboarding/maybeSeedOnboardingPack'
import { reconcileOnboardingWelcome } from '@/features/onboarding/reconcileOnboardingWelcome'
import { FirstRunActivationPanel } from '@/features/onboarding/components/FirstRunActivationPanel'
import {
  trackProductEvent,
  trackProductEventOnce,
} from '@/features/analytics/lib/productAnalytics'
import {
  completeWorkspaceOnboarding,
  markWorkspaceOnboardingPending,
  readWorkspaceOnboardingState,
  shouldShowWorkspaceOnboarding,
  skipWorkspaceOnboarding,
  type OnboardingProviderChoice,
} from '@/features/onboarding/onboardingState'
import { ONBOARDING_WELCOME_PATH } from '@/features/onboarding/onboardingManifest'

const CommandPalette = lazy(() =>
  import('@/app/components/CommandPalette').then((module) => ({ default: module.CommandPalette })),
)
const PortalProfileDialog = lazy(() =>
  import('@/app/PortalAccountControl').then((module) => ({ default: module.PortalProfileDialog })),
)
const ScenarioRoute = lazy(() =>
  import('@/features/scenario/pages/ScenarioRoute').then((module) => ({ default: module.ScenarioRoute })),
)
const DesktopSettingsPage = lazy(() =>
  import('@/features/settings/DesktopSettingsPage').then((module) => ({ default: module.DesktopSettingsPage })),
)
const SearchCommandPalette = lazy(() =>
  import('@/features/search/ui/SearchCommandPalette').then((module) => ({ default: module.SearchCommandPalette })),
)

// Module-level singleton: created once, reused across rootPath changes via init()
const searchService = new SearchService({
  workerFactory: () => new Worker(
    new URL('../features/search/worker/search.worker.ts', import.meta.url),
    { type: 'module' },
  ),
})

// V1 navigate adapters — openVaultPath has no Shell-level opener; dispatches a
// custom event that WorkspaceScreen can wire to in a follow-up.
const navigateAdapters: NavigateAdapters = {
  openVaultPath: async (vp) => {
    window.dispatchEvent(new CustomEvent('kition:search:open-path', { detail: { path: vp } }))
  },
  getCmViewForPath: () => null,   // V1 — flash wired in follow-up
  getKitableHandle: () => null,   // V1 — focus wired in follow-up
  showToast: (msg) => { toast(msg) },
}

const NOTE_READ_CONCURRENCY = 8

async function loadSearchNoteDocs(cancelled: () => boolean) {
  const mdFiles = await loadVaultMarkdownFiles()
  const noteDocs: ReturnType<typeof extractNoteDocs> = []
  let readFailures = 0

  for (let index = 0; index < mdFiles.length; index += NOTE_READ_CONCURRENCY) {
    if (cancelled()) break
    const batch = mdFiles.slice(index, index + NOTE_READ_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const document = await vaultClient.read(file.path)
        return extractNoteDocs({ vaultPath: file.path, content: document.content })
      }),
    )
    results.forEach((result, batchIndex) => {
      if (result.status === 'fulfilled') noteDocs.push(...result.value)
      else {
        readFailures += 1
        console.warn('[search] failed to read', batch[batchIndex]?.path, result.reason)
      }
    })
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }

  return { mdFileCount: mdFiles.length, noteDocs, readFailures }
}

function useSearchBoot(rootPath: string) {
  const [ready, setReady] = useState(false)
  const startRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    setReady(false)
    if (!rootPath) {
      startRef.current = () => undefined
      void searchService.destroy()
      return
    }

    let unsub = () => {}
    let cancelled = false
    let started = false
    let cancelScheduled = () => {}

    const start = () => {
      if (started || cancelled) return
      started = true
      cancelScheduled()
      void (async () => {
        try {
          const initOut = await searchService.init(rootPath)
          if (cancelled) return

          if (initOut.restoredFromDisk) setReady(true)
          unsub = attachEventBridges(searchService, {
            readMarkdown: async (vaultPath) => {
              const document = await vaultClient.read(vaultPath)
              return document.content
            },
            loadKitableTable: async (_vaultPath, _tableId) => {
              throw new Error('TODO at integration time — provide loadKitableTable')
            },
          })

          const scan = await loadSearchNoteDocs(() => cancelled)
          if (cancelled) return
          await searchService.bulkLoad(scan.noteDocs)
          if (!initOut.restoredFromDisk) setReady(true)
          console.info('[search boot]', {
            rootPath,
            restoredFromDisk: initOut.restoredFromDisk,
            restoredDocCount: initOut.docCount,
            mdFileCount: scan.mdFileCount,
            noteDocCount: scan.noteDocs.length,
            readFailures: scan.readFailures,
          })
        } catch (error) {
          if (!cancelled) console.warn('[search] boot failed', error)
        }
      })()
    }

    startRef.current = start
    cancelScheduled = scheduleSearchBoot(start)

    const onReload = () => {
      unsub()
      unsub = () => {}
      void searchService.destroy()
      setReady(false)
      started = false
      start()
    }
    window.addEventListener('kition:workspace-reload', onReload)

    return () => {
      cancelled = true
      cancelScheduled()
      unsub()
      startRef.current = () => undefined
      void searchService.destroy()
      window.removeEventListener('kition:workspace-reload', onReload)
    }
  }, [rootPath])

  const start = useCallback(() => startRef.current(), [])
  return { ready, start }
}

const settingsSectionKeys: SettingsSectionKey[] = [
  'general',
  'account',
  'models',
  'connections',
  'display',
  'network',
  'runtime',
  'developer',
  'about',
]
const settingsSectionAliases: Record<string, SettingsSectionKey> = {
  providers: 'models',
  'ai-providers': 'models',
  'email-providers': 'connections',
  demos: 'general',
  advanced: 'developer',
}

export function resolveSettingsSection(section: unknown): SettingsSectionKey {
  if (typeof section !== 'string') return 'general'
  if (settingsSectionAliases[section]) return settingsSectionAliases[section]
  return settingsSectionKeys.includes(section as SettingsSectionKey)
    ? section as SettingsSectionKey
    : 'general'
}

export function normalizeAppPathname(pathname: string): string {
  if (pathname === '/') return '/documents'
  if (
    pathname === '/documents'
    || pathname === '/settings'
    || pathname === '/scenario'
    || pathname.startsWith('/workflow')
  ) {
    return pathname
  }
  return '/documents'
}

function resolveSettingsSectionFromLocation() {
  const params = new URLSearchParams(window.location.search)
  return resolveSettingsSection(params.get('section'))
}

export function AppShell() {
  const { t } = useTranslation('common')
  const { t: tLauncher } = useTranslation('workspaceLauncher')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>('general')
  const [commandOpen, setCommandOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [scenarioOpen, setScenarioOpen] = useState(false)
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [workflowContext, setWorkflowContext] = useState<{ documentId: string; tableId: string; tableName: string } | null>(null)
  const [desktopPlatform, setDesktopPlatform] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)
  const [runtimeLabel, setRuntimeLabel] = useState<'local-runtime' | 'dev-runtime' | ''>('')
  const [hostOs, setHostOs] = useState<'mac' | 'windows' | 'linux' | 'ios' | 'android' | null>(null)
  const [topbarActionsPortal, setTopbarActionsPortal] = useState<HTMLElement | null>(null)
  const [topbarLeadingPortal, setTopbarLeadingPortal] = useState<HTMLElement | null>(null)
  const [launcherVariant, setLauncherVariant] = useState<'fullscreen' | 'dialog' | null>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const lastTrackedWorkspaceRef = useRef('')

                                                                  
                                           
                                                                  
                                                                  
                                                   
  const isNarrowShell = useMediaQuery('(max-width: 1023px)')
  const isTinyShell = useMediaQuery('(max-width: 479px)')
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false)

                                                      
                                           
  useEffect(() => {
    if (!isNarrowShell && sidebarDrawerOpen) {
      setSidebarDrawerOpen(false)
    }
  }, [isNarrowShell, sidebarDrawerOpen])

                   
  useEffect(() => {
    if (!sidebarDrawerOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSidebarDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sidebarDrawerOpen])
  const [launcherBusy, setLauncherBusy] = useState(false)
  const settingsModalOpen = settingsOpen

  // Search palette state
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    if (isWebPreviewMode()) {
      return
    }
    void restorePortalAccountSession().catch(() => {})
  }, [])

  const vaultRegistry = useWorkspaceVaults()
  const {
    vaults,
    activeVaultPath,
    loaded: vaultsLoaded,
    error: vaultsError,
    addVault,
    removeVault,
    renameVault,
    setActiveVault,
    chooseParentDirectory,
  } = vaultRegistry

  const { ready: searchReady, start: startSearch } = useSearchBoot(activeVaultPath || '')

  useEffect(() => {
    if (!activeVaultPath || lastTrackedWorkspaceRef.current === activeVaultPath) return
    lastTrackedWorkspaceRef.current = activeVaultPath
    trackProductEvent('workspace_opened')
  }, [activeVaultPath])

  const openSearch = useCallback(() => {
    startSearch()
    setPaletteOpen(true)
  }, [startSearch])

  useEffect(() => {
    if (!vaultsLoaded) {
      return
    }
    if (!activeVaultPath && launcherVariant === null) {
      setLauncherVariant('fullscreen')
    }
    if (activeVaultPath && launcherVariant === 'fullscreen') {
      setLauncherVariant(null)
    }
  }, [vaultsLoaded, activeVaultPath, launcherVariant])

  const openVaultLauncherDialog = useCallback(() => {
    setLauncherVariant((current) => (current === 'fullscreen' ? current : 'dialog'))
  }, [])

  const closeVaultLauncherDialog = useCallback(() => {
    setLauncherVariant((current) => (current === 'dialog' ? null : current))
  }, [])

  const notifyWorkspaceReload = useCallback((preferredPath?: string) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kition:workspace-reload', { detail: { preferredPath } }),
      )
    }
  }, [])

  const seedFirstRun = useCallback(async (path: string): Promise<string> => {
    try {
      return await maybeSeedOnboardingPack(path)
    } catch (err) {
      toast.error(tLauncher('firstRun.seedError', { message: (err as Error).message }))
      return ''
    }
  }, [tLauncher])

  const prepareFirstRun = useCallback(async (path: string) => {
    let migratedPath = ''
    try {
      migratedPath = await reconcileOnboardingWelcome()
    } catch (err) {
      toast.error(tLauncher('firstRun.seedError', { message: (err as Error).message }))
    }
    return {
      migratedPath,
      welcomePath: await seedFirstRun(path),
    }
  }, [seedFirstRun, tLauncher])

  const seedAttemptedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!vaultsLoaded || !activeVaultPath) return
    if (seedAttemptedRef.current.has(activeVaultPath)) return
    seedAttemptedRef.current.add(activeVaultPath)
    void (async () => {
      const { migratedPath, welcomePath } = await prepareFirstRun(activeVaultPath)
      if (welcomePath) {
        markWorkspaceOnboardingPending(activeVaultPath)
        notifyWorkspaceReload(welcomePath)
        setOnboardingOpen(true)
      } else if (migratedPath) {
        notifyWorkspaceReload(migratedPath)
      }
    })()
  }, [vaultsLoaded, activeVaultPath, prepareFirstRun, notifyWorkspaceReload])

  useEffect(() => {
    if (!vaultsLoaded || !activeVaultPath) {
      setOnboardingOpen(false)
      return
    }
    setOnboardingOpen(shouldShowWorkspaceOnboarding(activeVaultPath))
  }, [activeVaultPath, vaultsLoaded])

  useEffect(() => {
    if (onboardingOpen && activeVaultPath) {
      trackProductEventOnce('onboarding_started')
    }
  }, [activeVaultPath, onboardingOpen])

  const handleSelectVault = useCallback(
    async (path: string) => {
      setLauncherBusy(true)
      try {
        await setActiveVault(path)
        notifyWorkspaceReload()
        setLauncherVariant(null)
      } finally {
        setLauncherBusy(false)
      }
    },
    [setActiveVault, notifyWorkspaceReload],
  )

  const handleOpenLocalVault = useCallback(async () => {
    setLauncherBusy(true)
    try {
      const parent = await chooseParentDirectory()
      if (!parent) {
        return
      }
      const vault = await addVault({ path: parent })
      await setActiveVault(vault.path)
      notifyWorkspaceReload()
      setLauncherVariant(null)
    } finally {
      setLauncherBusy(false)
    }
  }, [addVault, chooseParentDirectory, setActiveVault, notifyWorkspaceReload])

  const handleRenameVault = useCallback(
    async (path: string, name: string) => {
      await renameVault(path, name)
    },
    [renameVault],
  )

  const handleRemoveVault = useCallback(
    async (path: string) => {
      await removeVault(path)
    },
    [removeVault],
  )

  const topbarActionsPortalRef = useCallback((node: HTMLDivElement | null) => {
    setTopbarActionsPortal(node)
  }, [])
  const topbarLeadingPortalRef = useCallback((node: HTMLDivElement | null) => {
    setTopbarLeadingPortal(node)
  }, [])

  const openSettings = useCallback((section: SettingsSectionKey = 'general') => {
    setProfileOpen(false)
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  useEffect(() => {
    function openOnboarding() {
      if (!activeVaultPath) return
      setSettingsOpen(false)
      setProfileOpen(false)
      setOnboardingOpen(true)
    }
    window.addEventListener('kition:onboarding:open', openOnboarding)
    return () => window.removeEventListener('kition:onboarding:open', openOnboarding)
  }, [activeVaultPath])

  const completeOnboarding = useCallback((choice: OnboardingProviderChoice) => {
    trackProductEventOnce('provider_choice_selected', { provider_choice: choice })
    trackProductEventOnce('onboarding_completed', {
      provider_choice: choice,
      result: 'success',
    })
    if (activeVaultPath) {
      completeWorkspaceOnboarding(activeVaultPath, choice)
    }
    setOnboardingOpen(false)
  }, [activeVaultPath])

  const startCloudOnboarding = useCallback(() => {
    completeOnboarding('cloud')
    notifyWorkspaceReload(ONBOARDING_WELCOME_PATH)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('kition:onboarding:start-agent', {
        detail: {
          documentPath: ONBOARDING_WELCOME_PATH,
          prompt: tLauncher('firstRun.agentPrompt'),
        },
      }))
    }, 0)
  }, [completeOnboarding, notifyWorkspaceReload, tLauncher])

  const configureModelsOnboarding = useCallback(() => {
    completeOnboarding('byo')
    openSettings('models')
  }, [completeOnboarding, openSettings])

  const startLocalOnboarding = useCallback(() => {
    completeOnboarding('local')
    notifyWorkspaceReload(ONBOARDING_WELCOME_PATH)
  }, [completeOnboarding, notifyWorkspaceReload])

  const skipOnboarding = useCallback(() => {
    if (activeVaultPath && readWorkspaceOnboardingState(activeVaultPath)?.status === 'pending') {
      skipWorkspaceOnboarding(activeVaultPath)
    }
    setOnboardingOpen(false)
  }, [activeVaultPath])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    if (window.location.pathname === '/settings') {
      window.history.replaceState(window.history.state, '', '/documents')
    }
  }, [])

  const openProfile = useCallback(() => {
    setSettingsOpen(false)
    setProfileOpen(true)
  }, [])

  useEffect(() => {
    function syncSettingsRoute() {
      const pathname = normalizeAppPathname(window.location.pathname)
      if (pathname !== window.location.pathname) {
        window.history.replaceState(window.history.state, '', pathname)
      }

      if (pathname === '/scenario') {
        setSettingsOpen(false)
        setScenarioOpen(true)
        return
      }

      setScenarioOpen(false)

      if (pathname.startsWith('/workflow')) {
        setSettingsOpen(false)
        setWorkflowOpen(true)
        const state = window.history.state as { workflowContext?: { documentId: string; tableId: string; tableName: string } } | null
        if (state?.workflowContext && state.workflowContext.documentId && state.workflowContext.tableId) {
          setWorkflowContext(state.workflowContext)
        } else {
          setWorkflowContext(null)
        }
        return
      }

      setWorkflowOpen(false)
      setWorkflowContext(null)

      if (pathname !== '/settings') {
        setSettingsOpen(false)
        return
      }

      openSettings(resolveSettingsSectionFromLocation())
    }

    syncSettingsRoute()
    window.addEventListener('popstate', syncSettingsRoute)
    return () => window.removeEventListener('popstate', syncSettingsRoute)
  }, [openSettings])

  // Decoupled "open Settings" trigger so unrelated features (workflow AI
  // dead-end, agent panel "configure model" CTA, etc.) can pop the
  // panel without having to thread the openSettings callback through
  // their prop chain. Listens for kition:settings:open with an optional
  // detail.section; falls back to general when omitted/invalid.
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { section?: unknown } | undefined
      openSettings(resolveSettingsSection(detail?.section))
    }
    window.addEventListener('kition:settings:open', handler)
    return () => window.removeEventListener('kition:settings:open', handler)
  }, [openSettings])

  useGlobalShortcuts({
    open_settings: () => openSettings(),
  })

  const closeScenarioRoute = useCallback(() => {
    setScenarioOpen(false)
    if (window.location.pathname === '/scenario') {
      window.history.replaceState(window.history.state, '', '/documents')
    }
  }, [])

  const closeWorkflowRoute = useCallback(() => {
    setWorkflowOpen(false)
    setWorkflowContext(null)
    if (window.location.pathname.startsWith('/workflow')) {
      window.history.replaceState(window.history.state, '', '/documents')
    }
  }, [])

  useEffect(() => {
    function onSearchHotkey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openSearch()
      }
    }
    window.addEventListener('keydown', onSearchHotkey)
    return () => window.removeEventListener('keydown', onSearchHotkey)
  }, [openSearch])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(true)
        return
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'o'
      ) {
        event.preventDefault()
        openVaultLauncherDialog()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openVaultLauncherDialog])

  useEffect(() => {
    let mounted = true

    Promise.all([
      getDesktopInfo(),
      getDesktopBackendStatus().catch(() => null),
    ])
      .then(([info, backendStatus]) => {
        if (mounted) {
          setDesktopPlatform(info?.platform || null)
          setAppVersion(info?.app_version || undefined)
          setRuntimeLabel(backendStatus?.runtime_label || '')
        }
      })
      .catch(() => {
        if (mounted) {
          setDesktopPlatform(null)
          setAppVersion(undefined)
          setRuntimeLabel('')
        }
      })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      return
    }
    const ua = navigator.userAgent || ''
    const platform = navigator.platform || ''
    const maxTouchPoints = (navigator as { maxTouchPoints?: number }).maxTouchPoints ?? 0
    if (/iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)) {
      setHostOs('ios')
    } else if (/Android/i.test(ua)) {
      setHostOs('android')
    } else if (/Mac|Darwin/i.test(platform) || /Mac OS X/i.test(ua)) {
      setHostOs('mac')
    } else if (/Win/i.test(platform)) {
      setHostOs('windows')
    } else if (/Linux/i.test(platform)) {
      setHostOs('linux')
    } else {
      setHostOs(null)
    }
  }, [])

  const showFullscreenLauncher = launcherVariant === 'fullscreen'

  return (
    <ConfirmProvider>
    <div
      className={cn(
        'app-shell',
        'is-document-route',
        settingsModalOpen && 'is-settings-modal-route',
        isNarrowShell && 'is-narrow',
        isTinyShell && 'is-tiny',
        sidebarDrawerOpen && 'is-sidebar-drawer-open',
      )}
      data-desktop-platform={desktopPlatform || undefined}
      data-host-os={hostOs || undefined}
    >
      <header className="app-topbar" onDoubleClick={handleDesktopChromeDoubleClick}>
        {isNarrowShell ? (
          <button
            type="button"
            data-testid="shell-sidebar-drawer-toggle"
            onClick={() => setSidebarDrawerOpen((open) => !open)}
            aria-label={sidebarDrawerOpen ? 'Close sidebar' : 'Open sidebar'}
            aria-expanded={sidebarDrawerOpen}
            className="mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {sidebarDrawerOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        ) : null}
        <div className="flex h-full min-w-0 flex-1 items-center">
          <div className="document-top-nav document-top-nav--tabs">
            <div ref={topbarLeadingPortalRef} className="document-topbar-tabs" data-testid="document-topbar-tabs" />
          </div>
        </div>
        {runtimeLabel ? (
          <span
            className="mr-1 shrink-0 rounded border border-border/80 bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
            data-testid="runtime-source-label"
          >
            {runtimeLabel}
          </span>
        ) : null}
        <div className="app-topbar-chat">
          <div ref={topbarActionsPortalRef} className="flex h-full min-w-0 flex-1 items-center gap-2" data-testid="document-topbar-actions" />
        </div>
      </header>
      {isNarrowShell && sidebarDrawerOpen ? (
        <div
          data-testid="shell-sidebar-drawer-backdrop"
          onClick={() => setSidebarDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-[1px]"
          aria-hidden="true"
        />
      ) : null}

      {isTinyShell ? (
        <div
          data-testid="shell-tiny-viewport-hint"
          className="fixed inset-x-0 bottom-3 z-[55] mx-3 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-soft"
        >
          {t('viewport.tooNarrow')}
        </div>
      ) : null}

      <main className="app-content app-content--wide" aria-hidden={settingsModalOpen || undefined}>
        {showFullscreenLauncher ? null : (
          <WorkspaceScreen
            onOpenSettingsSection={openSettings}
            onOpenProfile={desktopPlatform ? openProfile : undefined}
            onCloseProfile={() => setProfileOpen(false)}
            profileOpen={profileOpen}
            topbarActionsPortal={topbarActionsPortal}
            topbarLeadingPortal={topbarLeadingPortal}
            desktopPlatform={Boolean(desktopPlatform)}
            onOpenVaultLauncher={openVaultLauncherDialog}
            workflowOpen={workflowOpen}
            workflowContext={workflowContext}
            workflowSchemaLookup={(documentId, tableId) =>
              fetchWorkflowTableSchema(documentId, tableId, workflowContext?.tableName || 'Table')
            }
            onCloseWorkflow={closeWorkflowRoute}
            onOpenSearch={openSearch}
          />
        )}
      </main>
      {launcherVariant ? (
        <WorkspaceLauncherScreen
          variant={launcherVariant}
          vaults={vaults}
          activeVaultPath={activeVaultPath}
          appVersion={appVersion}
          loaded={vaultsLoaded}
          error={vaultsError}
          busy={launcherBusy}
          onSelectVault={handleSelectVault}
          onOpenLocalVault={handleOpenLocalVault}
          onRenameVault={handleRenameVault}
          onRemoveVault={handleRemoveVault}
          onClose={launcherVariant === 'dialog' ? closeVaultLauncherDialog : undefined}
        />
      ) : null}
      {onboardingOpen && activeVaultPath ? (
        <FirstRunActivationPanel
          key={activeVaultPath}
          workspaceName={vaults.find((vault) => vault.path === activeVaultPath)?.name || activeVaultPath.split(/[\\/]/).filter(Boolean).pop() || 'Kition'}
          onStartCloud={startCloudOnboarding}
          onConfigureModels={configureModelsOnboarding}
          onStartLocal={startLocalOnboarding}
          onSkip={skipOnboarding}
        />
      ) : null}
      {scenarioOpen ? (
        <div
          className="fixed inset-0 z-[60] overflow-hidden bg-background animate-fade-in"
          data-testid="scenario-route-overlay"
        >
          <Suspense fallback={null}>
            <ScenarioRoute onExit={closeScenarioRoute} />
          </Suspense>
        </div>
      ) : null}
      {settingsModalOpen ? (
        <Suspense fallback={null}>
          <DesktopSettingsPage
            initialSection={settingsSection}
            onClose={closeSettings}
          />
        </Suspense>
      ) : null}
      {profileOpen ? (
        <Suspense fallback={null}>
          <PortalProfileDialog onClose={() => setProfileOpen(false)} />
        </Suspense>
      ) : null}
      {commandOpen ? (
        <Suspense fallback={null}>
          <CommandPalette onClose={() => setCommandOpen(false)} onOpenSettings={() => openSettings('general')} />
        </Suspense>
      ) : null}
      {paletteOpen ? (
        <Suspense fallback={null}>
          <SearchCommandPalette
            service={searchService}
            ready={searchReady}
            open
            onClose={() => setPaletteOpen(false)}
            onPick={(hit) => { void navigateToHit(hit, navigateAdapters); setPaletteOpen(false) }}
          />
        </Suspense>
      ) : null}
      <ConsoleCreditsExhaustedBanner />
      <Toaster position="top-center" richColors closeButton />
    </div>
    </ConfirmProvider>
  )
}

async function fetchWorkflowTableSchema(documentId: string, tableId: string, tableName: string): Promise<TableSchema> {
  const res = await fetch(resolveApiURL(`/v1/data-documents/${documentId}/tables/${tableId}/fields`))
  if (!res.ok) throw new Error(`schema fetch failed (${res.status})`)
  const envelope = await res.json() as { data?: { items?: Array<{ id: number | string; name: string; title?: string; type: string }> } }
  const items = envelope.data?.items ?? []
  const fields = items.map((f) => ({
    id: String(f.id),
    name: (f.title ?? '').trim() ? (f.title as string) : f.name,
    type: f.type,
  }))
  return { id: tableId, name: tableName, fields }
}
