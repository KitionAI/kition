import { deleteSecureValue, getSecureValue, setSecureValue } from '@/services/desktop'
import type {
  DesktopAgentTimelineLineHeight,
  DesktopCodeFontFamily,
  DesktopDisplaySettings,
  DesktopHook,
  DesktopHookEvent,
  DesktopModelSettings,
  DesktopNotificationPolicy,
  DesktopProviderConfig,
  DesktopProviderDescriptor,
  DesktopProviderKind,
  DesktopSettingsState,
  DesktopShortcut,
  DesktopThemeMode,
  DesktopUiDensity,
} from '@/types/desktopSettings'

const SETTINGS_STORAGE_KEY = 'kition.desktop.settings.v1'
const SETTINGS_BACKUP_STORAGE_KEY = 'kition.desktop.settings.backup.v1'
const THEME_BOOTSTRAP_STORAGE_KEY = 'kition.desktop.theme.bootstrap.v1'
// One-time migration: existing installs saved 'light' as the old default theme.
// Rewrite that to 'dark' exactly once, then leave the user's choice alone.
const THEME_DARK_DEFAULT_MIGRATION_KEY = 'kition.desktop.theme.darkDefaultMigration.v1'
const SETTINGS_UPDATED_EVENT = 'desktop-settings-updated'
const SYSTEM_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)'
const PROVIDER_SECRET_FIELDS = ['apiKey', 'accessToken', 'refreshToken'] as const

// KitionAI Console proxies a fixed roster of upstream models — there is no
// per-user discovery step, so we seed sensible defaults on the client and let
// the server enforce the canonical list via the credit-aware proxy.
export const KITION_CONSOLE_DEFAULT_TEXT_MODELS = ['gpt-5.5']
const KITION_CONSOLE_DEFAULT_IMAGE_MODELS = ['gpt-image-1', 'dall-e-3']
export const KITION_CONSOLE_DEFAULT_MODELS = [
  ...KITION_CONSOLE_DEFAULT_TEXT_MODELS,
  ...KITION_CONSOLE_DEFAULT_IMAGE_MODELS,
]

let removeSystemThemeListener: (() => void) | null = null

export const desktopProviderCatalog: DesktopProviderDescriptor[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    sublabel: 'GPT · Codex',
    descriptor: 'OpenAI · GPT models',
    description: 'Connect to the Responses API using an OpenAI API Key. Suitable for Codex-style agents, hosted web search, and tool calls.',
    badge: 'Responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModelsPath: '/models',
    authLabel: 'OpenAI API Key',
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    sublabel: 'Claude',
    descriptor: 'Anthropic · Claude family',
    description: 'Connect to the Messages API using an Anthropic API Key. Supports Claude 4.x and the hosted web_search server tool.',
    badge: 'Messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModelsPath: '/v1/models',
    authLabel: 'Anthropic API Key',
  },
  {
    kind: 'deepseek',
    label: 'DeepSeek',
    sublabel: 'V3 · R1',
    descriptor: 'DeepSeek · V3 / R1 models',
    description: 'Connect to the DeepSeek OpenAI-compatible API using a DeepSeek API Key. Supports deepseek-chat and deepseek-reasoner.',
    badge: 'OpenAI-compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModelsPath: '/models',
    authLabel: 'DeepSeek API Key',
  },
  {
    kind: 'custom',
    label: 'Custom',
    sublabel: 'Self-hosted',
    descriptor: 'Custom provider · self-hosted endpoint',
    description: 'Custom model URL, auth header, and models endpoint path. Suitable for private deployments or specialized gateways.',
    badge: 'Flexible',
    defaultBaseUrl: '',
    defaultModelsPath: '/models',
    authLabel: 'Token',
  },
  {
    kind: 'kition_console',
    label: 'Kition Cloud',
    sublabel: 'Hosted AI',
    descriptor: 'Kition Cloud · hosted models',
    description: 'Use hosted models through your Kition Account. No separate API key is required, and usage is deducted from your Kition credits.',
    badge: 'Hosted Cloud',
    defaultBaseUrl: '',
    defaultModelsPath: '/models',
    authLabel: 'Kition Account',
  },
]

export const defaultShortcuts: DesktopShortcut[] = [
  { id: 'open_settings', label: 'Open settings', combo: 'Cmd+,', enabled: true, description: 'Open the desktop settings page.' },
  { id: 'open_help', label: 'Open help', combo: 'Shift+/', enabled: true, description: 'View help and runtime directories.' },
  { id: 'new_creation', label: 'New document', combo: 'Cmd+N', enabled: true, description: 'Jump to the local document library.' },
  { id: 'toggle_fullscreen', label: 'Toggle fullscreen', combo: 'F11', enabled: true, description: 'Toggle the current window fullscreen state.' },
  { id: 'reload_window', label: 'Reload window', combo: 'Cmd+R', enabled: true, description: 'Reload the current desktop window.' },
]

const DENSITY_VALUES: ReadonlyArray<DesktopUiDensity> = ['compact', 'normal', 'relaxed']
const LINE_HEIGHT_VALUES: ReadonlyArray<DesktopAgentTimelineLineHeight> = ['tight', 'normal', 'loose']
const CODE_FONT_FAMILY_VALUES: ReadonlyArray<DesktopCodeFontFamily> = [
  'JetBrains Mono',
  'Fira Code',
  'Menlo',
  'Consolas',
  'system-ui',
]
const HOOK_EVENT_VALUES: ReadonlyArray<DesktopHookEvent> = [
  'session_started',
  'task_started',
  'task_completed',
  'task_failed',
  'tool_called',
  'on_quit',
]

const AGENT_LINE_HEIGHT_MAP: Record<DesktopAgentTimelineLineHeight, string> = {
  tight: '1.4',
  normal: '1.55',
  loose: '1.75',
}

export function createDefaultDesktopDisplaySettings(): DesktopDisplaySettings {
  return {
    zoomLevel: 1,
    density: 'normal',
    codeFontFamily: 'JetBrains Mono',
    codeFontSize: 13,
    reduceMotion: false,
    agentTimelineLineHeight: 'normal',
    showDocumentToolbar: false,
  }
}

export function createDefaultDesktopNotificationPolicy(): DesktopNotificationPolicy {
  return {
    systemNotificationsEnabled: true,
    onTaskCompleted: true,
    onTaskFailed: true,
    onUserInputNeeded: true,
    longRunningThresholdSeconds: 0,
  }
}

export function normalizeProviderBaseURL(kind: DesktopProviderKind, baseUrl?: string) {
  const raw = String(baseUrl || '').trim()
  if (!raw) {
    return raw
  }

  try {
    const parsed = new URL(raw)
    // openai / deepseek / custom providers given a bare host need /v1 appended; an explicit path is kept as-is.
    if ((kind === 'openai' || kind === 'deepseek' || kind === 'custom') && (!parsed.pathname || parsed.pathname === '/')) {
      parsed.pathname = '/v1'
      return parsed.toString().replace(/\/$/, '')
    }
    return raw.replace(/\/$/, '')
  } catch {
    return raw
  }
}

function createProviderConfig(kind: DesktopProviderKind): DesktopProviderConfig {
  const descriptor = desktopProviderCatalog.find((item) => item.kind === kind)!
  const wireApi: DesktopProviderConfig['wireApi'] = kind === 'anthropic' ? 'anthropic_messages' : 'responses'
  const authScheme: DesktopProviderConfig['authScheme'] = kind === 'anthropic' ? 'x-api-key' : 'bearer'
  const authHeader = kind === 'custom' || kind === 'kition_console' ? 'Authorization' : ''
  return {
    kind,
    enabled: false,
    label: descriptor.label,
    baseUrl: descriptor.defaultBaseUrl,
    apiKey: '',
    accessToken: '',
    refreshToken: '',
    modelsPath: descriptor.defaultModelsPath,
    authHeader,
    authScheme,
    wireApi,
    reasoningEffort: 'medium',
    hostedWebSearchVersion: '20260209',
    disableResponseStorage: true,
    discoveredModels: [],
    lastSyncedAt: '',
  }
}

function createProviderMap() {
  return {
    openai: createProviderConfig('openai'),
    anthropic: createProviderConfig('anthropic'),
    deepseek: createProviderConfig('deepseek'),
    custom: createProviderConfig('custom'),
    kition_console: createProviderConfig('kition_console'),
  } satisfies Record<DesktopProviderKind, DesktopProviderConfig>
}

function createDefaultModelSettings(): DesktopModelSettings {
  return {
    activeProvider: 'kition_console',
    selectedModelByProvider: {},
    preferredDefaultModel: '',
    preferredChatModel: '',
    preferredWritingModel: '',
  }
}

export function createDefaultDesktopSettings(): DesktopSettingsState {
  return {
    general: {
      theme: 'dark',
      // North America is the default market. Existing on-disk preferences are preserved by
      // loadDesktopSettings() - only fresh installs see this value.
      language: 'en-US',
      restoreWorkspaceOnLaunch: true,
      confirmBeforeQuit: true,
      autoCheckUpdates: true,
      updateBetaChannel: false,
      shareUsageData: false,
      debug: false,
    },
    display: createDefaultDesktopDisplaySettings(),
    notifications: createDefaultDesktopNotificationPolicy(),
    hooks: [],
    shortcuts: defaultShortcuts.map((item) => ({ ...item })),
    providers: createProviderMap(),
    models: createDefaultModelSettings(),
  }
}

export async function loadDesktopSettings() {
  const fallback = createDefaultDesktopSettings()
  const backup = loadDesktopSettingsBackup()
  const raw = await getSecureValue(SETTINGS_STORAGE_KEY)

  let next: DesktopSettingsState
  let fromPersistedStore = false
  if (!raw) {
    next = normalizeDesktopSettings(backup || fallback)
  } else {
    try {
      next = normalizeDesktopSettings(JSON.parse(raw) as Partial<DesktopSettingsState>)
      fromPersistedStore = true
    } catch {
      next = normalizeDesktopSettings(backup || fallback)
    }
  }

  next = await migrateThemeToDarkDefault(next, fromPersistedStore)

  persistDesktopSettingsBackup(next)
  persistDesktopThemeBootstrap(next.general.theme)
  applyDesktopDisplay(next.display)
  return hydrateDesktopProviderSecrets(next)
}

export async function saveDesktopSettings(
  settings: DesktopSettingsState,
  options?: { clearProviderSecrets?: DesktopProviderKind[] },
) {
  const normalized = normalizeDesktopSettings(settings)
  const hydrated = await hydrateDesktopProviderSecrets(normalized)
  const redacted = structuredClone(hydrated)

  await persistDesktopProviderSecrets(normalized, hydrated, redacted, options)
  await setSecureValue(SETTINGS_STORAGE_KEY, JSON.stringify(redacted))
  persistDesktopSettingsBackup(redacted)
  persistDesktopThemeBootstrap(redacted.general.theme)
  applyDesktopDisplay(hydrated.display)
  broadcastDesktopSettingsUpdated(hydrated)
  return hydrated
}

export function normalizeDesktopSettings(input?: Partial<DesktopSettingsState>): DesktopSettingsState {
  const fallback = createDefaultDesktopSettings()
  const providerMap = createProviderMap()
  const inputProviders = (input?.providers || {}) as Partial<Record<DesktopProviderKind, Partial<DesktopProviderConfig>>>
  const normalizedTheme = normalizeDesktopThemeMode(input?.general?.theme)

  for (const descriptor of desktopProviderCatalog) {
    const current = inputProviders[descriptor.kind]
    const rawDiscovered = Array.isArray(current?.discoveredModels)
      ? current!.discoveredModels.filter(Boolean)
      : []
    // KitionAI Console does not require the user to run a discovery step —
    // its model list is curated server-side. Seed a fallback default list so
    // the agent / media pickers always have at least one option once the
    // user signs in.
    const discoveredModels = descriptor.kind === 'kition_console'
      ? [...KITION_CONSOLE_DEFAULT_MODELS]
      : rawDiscovered
    providerMap[descriptor.kind] = {
      ...providerMap[descriptor.kind],
      ...(current || {}),
      kind: descriptor.kind,
      label: current?.label || descriptor.label,
      baseUrl: normalizeProviderBaseURL(descriptor.kind, current?.baseUrl ?? descriptor.defaultBaseUrl),
      modelsPath: current?.modelsPath ?? descriptor.defaultModelsPath,
      discoveredModels,
    }
  }

  const shortcutMap = new Map((input?.shortcuts || []).map((item) => [item.id, item]))
  const shortcuts = defaultShortcuts.map((shortcut) => ({
    ...shortcut,
    ...(shortcutMap.get(shortcut.id) || {}),
  }))

  const requestedActiveProvider = String(input?.models?.activeProvider || '').trim()
  const activeProvider = desktopProviderCatalog.some((item) => item.kind === requestedActiveProvider)
    ? requestedActiveProvider as DesktopProviderKind
    : fallback.models.activeProvider
  const selectedModelByProvider = {
    ...(input?.models?.selectedModelByProvider || {}),
  }
  if (activeProvider === 'kition_console') {
    providerMap.kition_console.enabled = true
    if (!KITION_CONSOLE_DEFAULT_TEXT_MODELS.includes(selectedModelByProvider.kition_console || '')) {
      selectedModelByProvider.kition_console = KITION_CONSOLE_DEFAULT_TEXT_MODELS[0]
    }
  }

  return {
    general: {
      ...fallback.general,
      ...(input?.general || {}),
      theme: normalizedTheme,
    },
    display: normalizeDesktopDisplay(input?.display),
    notifications: normalizeDesktopNotifications(input?.notifications),
    hooks: normalizeDesktopHooks(input?.hooks),
    shortcuts,
    providers: providerMap,
    models: {
      ...fallback.models,
      ...(input?.models || {}),
      activeProvider,
      selectedModelByProvider,
    },
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(max, Math.max(min, value))
}

function roundTo(value: number, step: number) {
  return Math.round(value / step) * step
}

export function normalizeDesktopDisplay(input?: Partial<DesktopDisplaySettings>): DesktopDisplaySettings {
  const fallback = createDefaultDesktopDisplaySettings()
  const zoom = clamp(roundTo(Number(input?.zoomLevel ?? fallback.zoomLevel), 0.05), 0.85, 1.5)
  const codeSize = clamp(Math.round(Number(input?.codeFontSize ?? fallback.codeFontSize)), 12, 18)
  return {
    zoomLevel: Number(zoom.toFixed(2)),
    density: DENSITY_VALUES.includes(input?.density as DesktopUiDensity)
      ? (input!.density as DesktopUiDensity)
      : fallback.density,
    codeFontFamily: CODE_FONT_FAMILY_VALUES.includes(input?.codeFontFamily as DesktopCodeFontFamily)
      ? (input!.codeFontFamily as DesktopCodeFontFamily)
      : fallback.codeFontFamily,
    codeFontSize: codeSize,
    reduceMotion: Boolean(input?.reduceMotion ?? fallback.reduceMotion),
    agentTimelineLineHeight: LINE_HEIGHT_VALUES.includes(input?.agentTimelineLineHeight as DesktopAgentTimelineLineHeight)
      ? (input!.agentTimelineLineHeight as DesktopAgentTimelineLineHeight)
      : fallback.agentTimelineLineHeight,
    showDocumentToolbar: Boolean(input?.showDocumentToolbar ?? fallback.showDocumentToolbar),
  }
}

export function normalizeDesktopNotifications(input?: Partial<DesktopNotificationPolicy>): DesktopNotificationPolicy {
  const fallback = createDefaultDesktopNotificationPolicy()
  const threshold = clamp(Math.round(Number(input?.longRunningThresholdSeconds ?? fallback.longRunningThresholdSeconds)), 0, 3600)
  return {
    systemNotificationsEnabled: Boolean(input?.systemNotificationsEnabled ?? fallback.systemNotificationsEnabled),
    onTaskCompleted: Boolean(input?.onTaskCompleted ?? fallback.onTaskCompleted),
    onTaskFailed: Boolean(input?.onTaskFailed ?? fallback.onTaskFailed),
    onUserInputNeeded: Boolean(input?.onUserInputNeeded ?? fallback.onUserInputNeeded),
    longRunningThresholdSeconds: threshold,
  }
}

export function normalizeDesktopHooks(input?: DesktopHook[]): DesktopHook[] {
  if (!Array.isArray(input)) {
    return []
  }
  const result: DesktopHook[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const event = HOOK_EVENT_VALUES.includes(raw.event as DesktopHookEvent) ? raw.event : 'task_completed'
    const timeout = clamp(Math.round(Number(raw.timeoutSeconds ?? 30)), 1, 300)
    const id = String(raw.id || '').trim()
    if (!id) continue
    result.push({
      id,
      name: String(raw.name || '').slice(0, 60),
      enabled: Boolean(raw.enabled ?? true),
      event: event as DesktopHookEvent,
      command: String(raw.command || '').slice(0, 1024),
      workdir: String(raw.workdir || '').slice(0, 1024),
      timeoutSeconds: timeout,
      matcher: raw.matcher ? String(raw.matcher).slice(0, 256) : undefined,
      lastRunAt: raw.lastRunAt || undefined,
      lastExitCode: typeof raw.lastExitCode === 'number' ? raw.lastExitCode : undefined,
    })
  }
  return result
}

export function applyDesktopDisplay(display: DesktopDisplaySettings) {
  if (typeof document === 'undefined') {
    return
  }
  const root = document.documentElement
  root.style.setProperty('--app-zoom', String(display.zoomLevel))
  root.style.setProperty('--app-code-font-family', display.codeFontFamily)
  root.style.setProperty('--app-code-font-size', `${display.codeFontSize}px`)
  root.style.setProperty('--app-agent-line-height', AGENT_LINE_HEIGHT_MAP[display.agentTimelineLineHeight])
  root.dataset.density = display.density
  if (display.reduceMotion) {
    root.dataset.reduceMotion = '1'
  } else {
    delete root.dataset.reduceMotion
  }
}

export function applyDesktopAppearance(themeMode: DesktopThemeMode | string | undefined) {
  const normalizedThemeMode = normalizeDesktopThemeMode(themeMode)
  const resolvedTheme = resolveDesktopTheme(normalizedThemeMode)
  applyThemeToRoot(normalizedThemeMode, resolvedTheme)
  bindSystemThemeListener(normalizedThemeMode)
}

export function resolveDesktopTheme(themeMode: DesktopThemeMode) {
  if (themeMode === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return themeMode
}

export function formatShortcutFromEvent(event: KeyboardEvent) {
  const key = normalizeShortcutKey(event)
  if (!key) {
    return ''
  }

  const parts: string[] = []
  if (event.metaKey) parts.push('Cmd')
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

export function subscribeDesktopSettingsUpdated(handler: (settings: DesktopSettingsState) => void) {
  const listener = ((event: Event) => {
    const detail = (event as CustomEvent<DesktopSettingsState>).detail
    if (detail) {
      handler(normalizeDesktopSettings(detail))
    }
  }) as EventListener

  window.addEventListener(SETTINGS_UPDATED_EVENT, listener)
  return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, listener)
}

function broadcastDesktopSettingsUpdated(settings: DesktopSettingsState) {
  window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: settings }))
}

function normalizeDesktopThemeMode(themeMode?: string): DesktopThemeMode {
  if (themeMode === 'dark' || themeMode === 'light' || themeMode === 'auto') {
    return themeMode
  }

  if (themeMode === 'system') {
    return 'auto'
  }

  return 'dark'
}

function buildProviderSecretStorageKey(
  kind: DesktopProviderKind,
  field: (typeof PROVIDER_SECRET_FIELDS)[number],
) {
  return `desktop.provider.${kind}.${field}.v1`
}

async function hydrateDesktopProviderSecrets(settings: DesktopSettingsState) {
  const next = structuredClone(settings)

  await Promise.all(
    (Object.keys(next.providers) as DesktopProviderKind[]).flatMap((kind) =>
      PROVIDER_SECRET_FIELDS.map(async (field) => {
        const key = buildProviderSecretStorageKey(kind, field)
        const persistedSecret = await getSecureValue(key).catch(() => '')
        const inlineSecret = String(next.providers[kind][field] || '')
        const resolvedSecret = persistedSecret || inlineSecret

        next.providers[kind][field] = resolvedSecret

        if (resolvedSecret && !persistedSecret && inlineSecret) {
          await setSecureValue(key, resolvedSecret).catch(() => {})
        }
      }),
    ),
  )

  return next
}

async function persistDesktopProviderSecrets(
  normalized: DesktopSettingsState,
  hydrated: DesktopSettingsState,
  redacted: DesktopSettingsState,
  options?: { clearProviderSecrets?: DesktopProviderKind[] },
) {
  const clearProviderKinds = new Set(options?.clearProviderSecrets || [])

  await Promise.all(
    (Object.keys(hydrated.providers) as DesktopProviderKind[]).flatMap((kind) =>
      PROVIDER_SECRET_FIELDS.map(async (field) => {
        const key = buildProviderSecretStorageKey(kind, field)
        const provider = hydrated.providers[kind]
        const requestedProvider = normalized.providers[kind]
        const requestedValue = String(requestedProvider[field] || '')
        const persistedSecret = await getSecureValue(key).catch(() => '')
        const shouldDelete = clearProviderKinds.has(kind) && !requestedValue

        if (requestedValue) {
          await setSecureValue(key, requestedValue)
          provider[field] = requestedValue
        } else if (shouldDelete) {
          await deleteSecureValue(key).catch(() => {})
          provider[field] = ''
        } else if (persistedSecret) {
          provider[field] = persistedSecret
        }

        redacted.providers[kind][field] = ''
      }),
    ),
  )
}

function bindSystemThemeListener(themeMode: DesktopThemeMode) {
  removeSystemThemeListener?.()
  removeSystemThemeListener = null

  if (themeMode !== 'auto' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return
  }

  const mediaQuery = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY)
  const legacyMediaQuery = mediaQuery as MediaQueryList & {
    addListener?: (listener: (event: MediaQueryListEvent) => void) => void
    removeListener?: (listener: (event: MediaQueryListEvent) => void) => void
  }
  const handleChange = () => {
    if (document.documentElement.dataset.desktopThemeMode !== 'auto') {
      return
    }

    const resolvedTheme = resolveDesktopTheme('auto')
    applyThemeToRoot('auto', resolvedTheme)
  }

  if ('addEventListener' in mediaQuery) {
    mediaQuery.addEventListener('change', handleChange)
    removeSystemThemeListener = () => mediaQuery.removeEventListener('change', handleChange)
    return
  }

  legacyMediaQuery.addListener?.(handleChange)
  removeSystemThemeListener = () => legacyMediaQuery.removeListener?.(handleChange)
}

function applyThemeToRoot(themeMode: DesktopThemeMode, resolvedTheme: 'light' | 'dark') {
  const root = document.documentElement
  beginThemeTransition(root)
  root.dataset.desktopThemeMode = themeMode
  root.dataset.desktopTheme = resolvedTheme
  root.classList.toggle('dark', resolvedTheme === 'dark')
  root.style.colorScheme = resolvedTheme
}

function beginThemeTransition(root: HTMLElement) {
  root.classList.add('theme-transitioning')

  const nextFrame = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16)

  nextFrame(() => {
    nextFrame(() => {
      root.classList.remove('theme-transitioning')
    })
  })
}

function normalizeShortcutKey(event: KeyboardEvent) {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) {
    return ''
  }

  const specialKeys: Record<string, string> = {
    ',': ',',
    '.': '.',
    '/': '/',
    '?': '/',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
    ' ': 'Space',
  }

  if (specialKeys[event.key]) {
    return specialKeys[event.key]
  }

  if (event.key.startsWith('F') && Number.isFinite(Number(event.key.slice(1)))) {
    return event.key.toUpperCase()
  }

  if (event.code === 'Slash') {
    return '/'
  }
  if (event.code === 'Comma') {
    return ','
  }
  if (event.code === 'Period') {
    return '.'
  }

  if (event.key.length === 1) {
    return event.key.toUpperCase()
  }

  return event.key
}

async function migrateThemeToDarkDefault(
  settings: DesktopSettingsState,
  fromPersistedStore: boolean,
): Promise<DesktopSettingsState> {
  if (hasRunThemeDarkDefaultMigration()) {
    return settings
  }

  if (settings.general.theme !== 'light') {
    markThemeDarkDefaultMigrationDone()
    return settings
  }

  const migrated: DesktopSettingsState = {
    ...settings,
    general: { ...settings.general, theme: 'dark' },
  }

  // Persist back so the flipped theme survives the next launch. `settings` is the
  // normalized (secret-redacted) shape, matching what saveDesktopSettings writes.
  if (fromPersistedStore) {
    try {
      await setSecureValue(SETTINGS_STORAGE_KEY, JSON.stringify(migrated))
    } catch {
      // Leave the migration flag unset so we retry on the next launch. The
      // in-memory value still applies dark for this session.
      return migrated
    }
  }

  markThemeDarkDefaultMigrationDone()
  return migrated
}

function hasRunThemeDarkDefaultMigration() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return true
  }
  try {
    return window.localStorage.getItem(THEME_DARK_DEFAULT_MIGRATION_KEY) === 'done'
  } catch {
    return true
  }
}

function markThemeDarkDefaultMigrationDone() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    window.localStorage.setItem(THEME_DARK_DEFAULT_MIGRATION_KEY, 'done')
  } catch {
    // Ignore — worst case the migration re-runs next launch, which is idempotent.
  }
}

function persistDesktopThemeBootstrap(themeMode: DesktopThemeMode) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    window.localStorage.setItem(THEME_BOOTSTRAP_STORAGE_KEY, themeMode)
  } catch {
    // The secure settings store remains authoritative when localStorage is unavailable.
  }
}

function loadDesktopSettingsBackup() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_BACKUP_STORAGE_KEY)
    if (!raw) {
      return null
    }
    return JSON.parse(raw) as Partial<DesktopSettingsState>
  } catch {
    return null
  }
}

function persistDesktopSettingsBackup(settings: Partial<DesktopSettingsState>) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }

  try {
    window.localStorage.setItem(SETTINGS_BACKUP_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore backup persistence failures and continue using the secure store copy.
  }
}
