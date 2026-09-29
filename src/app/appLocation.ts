/**
 * The app's top-level location as a value: which full-screen view the URL
 * names and what that view needs. The shell parses the URL once, applies
 * the result, and never reads `window.location` piecemeal.
 */
import type { SettingsSectionKey } from '@/features/settings/DesktopSettingsPage'
import type { WorkflowRouteContext } from '@/features/workflow/public'

export type AppLocation =
  | { view: 'documents' }
  | { view: 'settings'; section: SettingsSectionKey }
  | { view: 'scenario' }
  | { view: 'workflow'; pathname: string; context: WorkflowRouteContext | null }

export type AppView = AppLocation['view']

const DEFAULT_APP_PATHNAME = '/documents'

const settingsSectionKeys: SettingsSectionKey[] = [
  'general',
  'account',
  'models',
  'connections',
  'display',
  'brand',
  'network',
  'runtime',
  'developer',
  'about',
]

/** Old deep links keep working: each retired section maps to its new home. */
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

/** Pathnames the shell still serves; anything else returns to the documents workspace. */
export function normalizeAppPathname(pathname: string): string {
  if (pathname === '/') return DEFAULT_APP_PATHNAME
  if (
    pathname === DEFAULT_APP_PATHNAME
    || pathname === '/settings'
    || pathname === '/scenario'
    || pathname.startsWith('/workflow')
  ) {
    return pathname
  }
  return DEFAULT_APP_PATHNAME
}

function readWorkflowContext(state: unknown): WorkflowRouteContext | null {
  const context = (state as { workflowContext?: Partial<WorkflowRouteContext> } | null)?.workflowContext
  if (!context || !context.documentId || !context.tableId) return null
  return { documentId: context.documentId, tableId: context.tableId, tableName: context.tableName || '' }
}

export function parseAppLocation(input: { pathname: string; search: string; state: unknown }): AppLocation {
  const pathname = normalizeAppPathname(input.pathname)
  if (pathname === '/scenario') return { view: 'scenario' }
  if (pathname.startsWith('/workflow')) {
    return { view: 'workflow', pathname, context: readWorkflowContext(input.state) }
  }
  if (pathname === '/settings') {
    return { view: 'settings', section: resolveSettingsSection(new URLSearchParams(input.search).get('section')) }
  }
  return { view: 'documents' }
}

/** The pathname a location lives at; the workflow view keeps whatever sub-path it was opened with. */
export function appLocationPathname(location: AppLocation): string {
  switch (location.view) {
    case 'settings':
      return '/settings'
    case 'scenario':
      return '/scenario'
    case 'workflow':
      return location.pathname
    default:
      return DEFAULT_APP_PATHNAME
  }
}

/** The location the browser is showing right now. */
export function readAppLocation(): AppLocation {
  return parseAppLocation({
    pathname: window.location.pathname,
    search: window.location.search,
    state: window.history.state,
  })
}

/** Returns the URL to the documents workspace when it currently names `view`. Closing a view must not disturb an unrelated URL. */
export function leaveAppView(view: AppView) {
  if (readAppLocation().view !== view) return
  window.history.replaceState(window.history.state, '', DEFAULT_APP_PATHNAME)
}
