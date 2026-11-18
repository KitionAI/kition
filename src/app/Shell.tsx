import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MenuIcon as Menu, XIcon as X } from '@kition/tessera-icons/react'
import { cn } from '@/lib/cn'
import { ConfirmProvider, toast, Toaster, useMediaQuery } from '@kition/tessera-ui'
import { ConsoleCreditsExhaustedBanner } from '@/app/ConsoleCreditsExhaustedBanner'
import type { SettingsSectionKey } from '@/features/settings/DesktopSettingsPage'
import { appLocationPathname, leaveAppView, readAppLocation, resolveSettingsSection, type AppLocation } from '@/app/appLocation'
import { useShortcut } from '@/lib/useShortcut'
import { useGlobalShortcuts } from '@/features/settings/useGlobalShortcuts'
import { WorkspaceScreen } from '@/features/workspace/components/WorkspaceScreen'
import { WorkspaceLauncherScreen } from '@/features/workspace/components/WorkspaceLauncherScreen'
import { WorkspaceOpenModeDialog } from '@/features/workspace/components/WorkspaceOpenModeDialog'
import { useWorkspaceVaults } from '@/features/workspace/hooks/useWorkspaceVaults'
import { getWorkspaceDisplayName } from '@/features/workspace/lib/workspacePersistence'
import { isWebPreviewMode } from '@/lib/runtimeMode'
import { handleDesktopChromeDoubleClick } from '@/lib/windowChrome'
import {
  getDesktopBackendStatus,
  getDesktopInfo,
  openWorkspaceWindow,
} from '@/services/desktop'
import { restorePortalAccountSession } from '@/services/portalAccount'
import { CollabDialogs, requestOpenSharedDocument, requestSyncedDocuments, startCollab, useCollabAvailable } from '@/features/collab/public'
import { embeddedKitFor, sharedKitFor } from '@/features/workspace/components/kits/kitEditors'
import { DocumentHistoryHost } from '@/features/history/public'
import { requestShowWorkspaceFile } from '@/features/workspace/lib/workspaceFileRequests'
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
import { ExtensionDialogs, startInstalledExtensions } from '@/features/extensions/public'

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
/** Where toasts start: below the workspace's tab strip (36px) with a gap. */
const TOAST_TOP_OFFSET = 48

export function AppShell() {
  const { t } = useTranslation('common')
  const { t: tLauncher } = useTranslation('workspaceLauncher')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>('general')
  const [commandOpen, setCommandOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [scenarioOpen, setScenarioOpen] = useState(false)
  const [desktopPlatform, setDesktopPlatform] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)
  const [runtimeLabel, setRuntimeLabel] = useState<'local-runtime' | 'dev-runtime' | ''>('')
  const [hostOs, setHostOs] = useState<'mac' | 'windows' | 'linux' | 'ios' | 'android' | null>(null)
  const [topbarActionsPortal, setTopbarActionsPortal] = useState<HTMLElement | null>(null)
  const [topbarLeadingPortal, setTopbarLeadingPortal] = useState<HTMLElement | null>(null)
  const [launcherVariant, setLauncherVariant] = useState<'fullscreen' | 'dialog' | null>(null)
  const [pendingWorkspaceOpen, setPendingWorkspaceOpen] = useState<{ path: string; name: string } | null>(null)
  const [workspaceOpenError, setWorkspaceOpenError] = useState('')
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const lastTrackedWorkspaceRef = useRef('')

  const isNarrowShell = useMediaQuery('(max-width: 1023px)')
  const isTinyShell = useMediaQuery('(max-width: 479px)')
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false)

  // Installed, enabled extensions may activate when a kit document opens: start their host.
  useEffect(() => {
    void startInstalledExtensions()
  }, [])

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

  useEffect(() => {
    if (isWebPreviewMode()) {
      return
    }
    void restorePortalAccountSession().catch(() => {})
  }, [])

  // Co-editing follows the open kit documents; it stays off without a sync server and a signed-in Kition account.
  useEffect(() => startCollab(), [])
  const collabAvailable = useCollabAvailable()

  const vaultRegistry = useWorkspaceVaults()
  const {
    vaults,
    activeVaultPath,
    loaded: vaultsLoaded,
    error: vaultsError,
    refresh: refreshVaults,
    addVault,
    removeVault,
    renameVault,
    setActiveVault,
    chooseParentDirectory,
  } = vaultRegistry

  useEffect(() => {
    if (!activeVaultPath || lastTrackedWorkspaceRef.current === activeVaultPath) return
    lastTrackedWorkspaceRef.current = activeVaultPath
    trackProductEvent('workspace_opened')
  }, [activeVaultPath])

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

  useEffect(() => {
    if (launcherVariant) {
      void refreshVaults()
    }
  }, [launcherVariant, refreshVaults])

  const openVaultLauncherDialog = useCallback(() => {
    setLauncherVariant((current) => (current === 'fullscreen' ? current : 'dialog'))
  }, [])

  const closeVaultLauncherDialog = useCallback(() => {
    setPendingWorkspaceOpen(null)
    setWorkspaceOpenError('')
    setLauncherVariant((current) => (current === 'dialog' ? null : current))
  }, [])

  const notifyWorkspaceReload = useCallback((preferredPath?: string, onlyWhenEmpty = false) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kition:workspace-reload', { detail: { preferredPath, onlyWhenEmpty } }),
      )
    }
  }, [])

  // The internal error goes to the log, not the toast: the person gets plain words and a Retry
  // that runs the first-run setup of that workspace again.
  const retryFirstRunRef = useRef<(path: string) => void>(() => undefined)
  const reportFirstRunError = useCallback((err: unknown, path: string) => {
    console.error('[first-run] setting up Getting Started failed', err)
    toast.error(tLauncher('firstRun.seedError'), {
      action: { label: tLauncher('firstRun.seedRetry'), onClick: () => retryFirstRunRef.current(path) },
    })
  }, [tLauncher])

  const seedFirstRun = useCallback(async (path: string): Promise<string> => {
    try {
      return await maybeSeedOnboardingPack(path)
    } catch (err) {
      reportFirstRunError(err, path)
      return ''
    }
  }, [reportFirstRunError])

  const prepareFirstRun = useCallback(async (path: string) => {
    let migratedPath = ''
    try {
      migratedPath = await reconcileOnboardingWelcome()
    } catch (err) {
      reportFirstRunError(err, path)
    }
    return {
      migratedPath,
      welcomePath: await seedFirstRun(path),
    }
  }, [seedFirstRun, reportFirstRunError])

  const runFirstRun = useCallback(async (path: string) => {
    const { migratedPath, welcomePath } = await prepareFirstRun(path)
    if (welcomePath) {
      markWorkspaceOnboardingPending(path)
      notifyWorkspaceReload(welcomePath, true)
      setOnboardingOpen(true)
    } else if (migratedPath) {
      notifyWorkspaceReload(migratedPath, true)
    }
  }, [prepareFirstRun, notifyWorkspaceReload])

  useEffect(() => {
    retryFirstRunRef.current = (path) => void runFirstRun(path)
  }, [runFirstRun])

  const seedAttemptedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!vaultsLoaded || !activeVaultPath) return
    if (seedAttemptedRef.current.has(activeVaultPath)) return
    seedAttemptedRef.current.add(activeVaultPath)
    void runFirstRun(activeVaultPath)
  }, [vaultsLoaded, activeVaultPath, runFirstRun])

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

  const openWorkspaceInCurrentWindow = useCallback(async (path: string) => {
    setLauncherBusy(true)
    setWorkspaceOpenError('')
    try {
      await setActiveVault(path)
      notifyWorkspaceReload()
      setPendingWorkspaceOpen(null)
      setLauncherVariant(null)
    } finally {
      setLauncherBusy(false)
    }
  }, [setActiveVault, notifyWorkspaceReload])

  const requestWorkspaceOpen = useCallback(async (path: string) => {
    if (launcherVariant === 'dialog' && activeVaultPath && desktopPlatform) {
      const vault = vaults.find((candidate) => candidate.path === path)
      setWorkspaceOpenError('')
      setPendingWorkspaceOpen({
        path,
        name: vault?.name || getWorkspaceDisplayName(path),
      })
      return
    }
    await openWorkspaceInCurrentWindow(path)
  }, [activeVaultPath, desktopPlatform, launcherVariant, openWorkspaceInCurrentWindow, vaults])

  const handleSelectVault = useCallback(
    async (path: string) => requestWorkspaceOpen(path),
    [requestWorkspaceOpen],
  )

  const handleOpenLocalVault = useCallback(async () => {
    let workspacePath = ''
    setLauncherBusy(true)
    try {
      const parent = await chooseParentDirectory()
      if (!parent) {
        return
      }
      const vault = await addVault({ path: parent })
      workspacePath = vault.path
    } finally {
      setLauncherBusy(false)
    }
    if (workspacePath) {
      await requestWorkspaceOpen(workspacePath)
    }
  }, [addVault, chooseParentDirectory, requestWorkspaceOpen])

  const handleOpenWorkspaceInNewWindow = useCallback(async () => {
    if (!pendingWorkspaceOpen) {
      return
    }
    setLauncherBusy(true)
    setWorkspaceOpenError('')
    try {
      await openWorkspaceWindow(pendingWorkspaceOpen.path)
      setPendingWorkspaceOpen(null)
      setLauncherVariant(null)
    } catch (requestError) {
      setWorkspaceOpenError(
        requestError instanceof Error ? requestError.message : tLauncher('errors.newWindow'),
      )
    } finally {
      setLauncherBusy(false)
    }
  }, [pendingWorkspaceOpen, tLauncher])

  const handleOpenWorkspaceInCurrentWindow = useCallback(async () => {
    if (!pendingWorkspaceOpen) {
      return
    }
    try {
      await openWorkspaceInCurrentWindow(pendingWorkspaceOpen.path)
    } catch (requestError) {
      setWorkspaceOpenError(
        requestError instanceof Error ? requestError.message : tLauncher('errors.switch'),
      )
    }
  }, [openWorkspaceInCurrentWindow, pendingWorkspaceOpen, tLauncher])

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
    leaveAppView('settings')
  }, [])

  const openProfile = useCallback(() => {
    setSettingsOpen(false)
    setProfileOpen(true)
  }, [])

  // The URL is the source of truth for the full-screen views. Applying a
  // parsed location keeps the four view states consistent with each other.
  const applyAppLocation = useCallback((location: AppLocation) => {
    setScenarioOpen(location.view === 'scenario')
    if (location.view === 'settings') {
      openSettings(location.section)
    } else {
      setSettingsOpen(false)
    }
  }, [openSettings])

  useEffect(() => {
    function syncAppLocation() {
      const location = readAppLocation()
      const pathname = appLocationPathname(location)
      if (pathname !== window.location.pathname) {
        window.history.replaceState(window.history.state, '', pathname)
      }
      applyAppLocation(location)
    }

    syncAppLocation()
    window.addEventListener('popstate', syncAppLocation)
    return () => window.removeEventListener('popstate', syncAppLocation)
  }, [applyAppLocation])

  // Decoupled "open Settings" trigger so unrelated features (the agent
  // panel "configure model" CTA, etc.) can pop the
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
    leaveAppView('scenario')
  }, [])

  useShortcut('Mod+K', () => setCommandOpen(true))
  // Inside a kit editor Cmd+K is the kit's own; the kit forwards Cmd+. (KitFrame's HOST_SHORTCUTS).
  useShortcut('Mod+.', () => setCommandOpen(true))
  useShortcut('Mod+Shift+O', openVaultLauncherDialog)

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
      <WorkspaceOpenModeDialog
        open={Boolean(pendingWorkspaceOpen)}
        workspaceName={pendingWorkspaceOpen?.name || ''}
        workspacePath={pendingWorkspaceOpen?.path || ''}
        busy={launcherBusy}
        errorMessage={workspaceOpenError}
        onOpenChange={(open) => {
          if (!open) {
            setPendingWorkspaceOpen(null)
            setWorkspaceOpenError('')
          }
        }}
        onOpenCurrent={() => {
          void handleOpenWorkspaceInCurrentWindow()
        }}
        onOpenNew={() => {
          void handleOpenWorkspaceInNewWindow()
        }}
      />
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
          <CommandPalette onClose={() => setCommandOpen(false)} onOpenSettings={() => openSettings('general')} onOpenShared={collabAvailable ? requestOpenSharedDocument : undefined} onOpenSynced={collabAvailable ? requestSyncedDocuments : undefined} />
        </Suspense>
      ) : null}
      <CollabDialogs kitFor={sharedKitFor} onOpened={(path) => requestShowWorkspaceFile(path, true)} />
      <DocumentHistoryHost kitFor={embeddedKitFor} />
      <ExtensionDialogs />
      <ConsoleCreditsExhaustedBanner />
      {/* Below the tab strip: a toast must never cover the tab chrome (docs/design.md). */}
      <Toaster offset={TOAST_TOP_OFFSET} />
    </div>
    </ConfirmProvider>
  )
}
