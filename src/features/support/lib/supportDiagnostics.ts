import type { KitionAccountStatus } from '@/features/account/lib/accountState'
import {
  getDesktopBackendStatus,
  getDesktopBootstrapStatus,
  getDesktopInfo,
  type BootstrapStatus,
  type DesktopBackendStatus,
  type DesktopInfo,
} from '@/services/desktop'
import type { UpdateState } from '@/services/desktopUpdates'

export type SupportDiagnosticSnapshot = {
  schema: 'kition-support-diagnostics/v1'
  appVersion: string
  appCommit: string
  buildIdentity: string
  builtAt: string
  platform: string
  runtimeProtocol: string
  runtimeState: 'ready' | 'unavailable' | 'unknown'
  accountState: KitionAccountStatus
  updateState: UpdateState['phase']
  networkState: 'ok' | 'unavailable' | 'unknown'
  startupState: string
  startupCode: string
  supportId: string
}

type DiagnosticSources = {
  desktopInfo: DesktopInfo | null
  backendStatus: DesktopBackendStatus | null
  bootstrapStatus: BootstrapStatus | null
}

type DiagnosticDeps = {
  getDesktopInfo: () => Promise<DesktopInfo | null>
  getDesktopBackendStatus: () => Promise<DesktopBackendStatus | null>
  getDesktopBootstrapStatus: () => Promise<BootstrapStatus>
}

const defaultDeps: DiagnosticDeps = {
  getDesktopInfo,
  getDesktopBackendStatus,
  getDesktopBootstrapStatus,
}

function safeIdentifier(value: unknown, fallback: string) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(normalized)
    ? normalized
    : fallback
}

function safeTimestamp(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'unknown'
}

function normalizePlatform(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'darwin' || normalized.includes('mac')) return 'macos'
  if (normalized === 'win32' || normalized.includes('windows')) return 'windows'
  if (normalized === 'linux') return 'linux'
  return normalized === 'web' ? 'web' : 'unknown'
}

function resolveRuntimeState(status: DesktopBackendStatus | null): SupportDiagnosticSnapshot['runtimeState'] {
  if (!status) return 'unknown'
  return status.running ? 'ready' : 'unavailable'
}

function resolveNetworkState(
  backendStatus: DesktopBackendStatus | null,
  bootstrapStatus: BootstrapStatus | null,
  updateState: UpdateState,
): SupportDiagnosticSnapshot['networkState'] {
  if (updateState.phase === 'error' && updateState.errorKind === 'network') return 'unavailable'
  const startupCode = String(bootstrapStatus?.diagnostics?.code || '').toLowerCase()
  if (/network|offline|timeout|connection/.test(startupCode)) return 'unavailable'
  if (backendStatus?.running || bootstrapStatus?.available) return 'ok'
  return 'unknown'
}

async function loadSources(deps: DiagnosticDeps): Promise<DiagnosticSources> {
  const [desktopInfo, backendStatus, bootstrapStatus] = await Promise.allSettled([
    deps.getDesktopInfo(),
    deps.getDesktopBackendStatus(),
    deps.getDesktopBootstrapStatus(),
  ])
  return {
    desktopInfo: desktopInfo.status === 'fulfilled' ? desktopInfo.value : null,
    backendStatus: backendStatus.status === 'fulfilled' ? backendStatus.value : null,
    bootstrapStatus: bootstrapStatus.status === 'fulfilled' ? bootstrapStatus.value : null,
  }
}

export async function collectSupportDiagnostics(input: {
  appVersion: string
  appCommit: string
  buildIdentity: string
  builtAt: string
  accountState: KitionAccountStatus
  updateState: UpdateState
}, deps: DiagnosticDeps = defaultDeps): Promise<SupportDiagnosticSnapshot> {
  const sources = await loadSources(deps)
  const protocol = sources.backendStatus?.protocol_version
  return {
    schema: 'kition-support-diagnostics/v1',
    appVersion: safeIdentifier(sources.desktopInfo?.app_version || input.appVersion, 'unknown'),
    appCommit: safeIdentifier(input.appCommit, 'unknown'),
    buildIdentity: safeIdentifier(input.buildIdentity, 'unknown'),
    builtAt: safeTimestamp(input.builtAt),
    platform: normalizePlatform(sources.desktopInfo?.platform),
    runtimeProtocol: typeof protocol === 'number' && Number.isFinite(protocol)
      ? String(Math.max(0, Math.trunc(protocol)))
      : 'unknown',
    runtimeState: resolveRuntimeState(sources.backendStatus),
    accountState: input.accountState,
    updateState: input.updateState.phase,
    networkState: resolveNetworkState(sources.backendStatus, sources.bootstrapStatus, input.updateState),
    startupState: safeIdentifier(sources.bootstrapStatus?.state, 'unknown'),
    startupCode: safeIdentifier(sources.bootstrapStatus?.diagnostics?.code, 'none'),
    supportId: safeIdentifier(sources.bootstrapStatus?.diagnostics?.support_id, 'none'),
  }
}

export function formatSupportDiagnostics(snapshot: SupportDiagnosticSnapshot) {
  return [
    'Kition support diagnostics',
    `schema: ${snapshot.schema}`,
    `app.version: ${snapshot.appVersion}`,
    `app.commit: ${snapshot.appCommit}`,
    `build.identity: ${snapshot.buildIdentity}`,
    `build.time: ${snapshot.builtAt}`,
    `platform: ${snapshot.platform}`,
    `runtime.protocol: ${snapshot.runtimeProtocol}`,
    `runtime.state: ${snapshot.runtimeState}`,
    `account.state: ${snapshot.accountState}`,
    `update.state: ${snapshot.updateState}`,
    `network.state: ${snapshot.networkState}`,
    `startup.state: ${snapshot.startupState}`,
    `startup.code: ${snapshot.startupCode}`,
    `support.id: ${snapshot.supportId}`,
  ].join('\n')
}

export async function copyTextToClipboard(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  if (typeof document === 'undefined') {
    throw new Error('clipboard is unavailable')
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand?.('copy') ?? false
  textarea.remove()
  if (!copied) throw new Error('clipboard is unavailable')
}
