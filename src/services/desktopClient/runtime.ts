/**
 * Runtime location and health: platform checks, API base resolution, backend readiness, bootstrap, feedback, notifications, and window actions.
 */
import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import { type BootstrapAttestationRequest, type DesktopBackendStatus, type DesktopInfo, type FeedbackReportSubmissionRequest, getDesktopBridge } from './bridge'

const desktopBackendOriginFallback = 'http://127.0.0.1:18101'
const apiPrefix = '/api'
const backendHealthPath = '/health'
let desktopBackendReadyPromise: Promise<boolean> | null = null
export function normalizeDesktopPlatform(platform?: string | null) {
  const normalized = String(platform || '').trim().toLowerCase()
  switch (normalized) {
    case 'win32':
      return 'windows'
    case 'macos':
    case 'mac':
    case 'osx':
      return 'darwin'
    default:
      return normalized
  }
}

export function isDesktopRuntime() {
  return Boolean(getDesktopBridge())
}

export function isElectronDesktopRuntime() {
  return getDesktopBridge()?.shell === 'electron'
}

function getDesktopBackendOrigin() {
  return getDesktopBridge()?.backendOrigin || desktopBackendOriginFallback
}

export function normalizeApiPath(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path
  }

  const normalizedPath = path.startsWith(apiPrefix)
    ? path.slice(apiPrefix.length)
    : path

  if (!normalizedPath) {
    return '/'
  }

  return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`
}

function getLocalE2EApiBaseURL() {
  if (typeof window === 'undefined') {
    return ''
  }
  return String(window.localStorage.getItem('kition.e2e.apiBaseUrl') || '').trim().replace(/\/+$/, '')
}

export function getApiBaseURL() {
  const e2eBaseURL = getLocalE2EApiBaseURL()
  if (e2eBaseURL) {
    return e2eBaseURL
  }
  return isDesktopRuntime() ? `${getDesktopBackendOrigin()}${apiPrefix}` : apiPrefix
}

export function resolveApiURL(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path
  }

  return `${getApiBaseURL()}${normalizeApiPath(path)}`
}

export function resolvePublicFileURL(path: string) {
  const bundledAssetPath = path.match(/^kition-bundled:(\/?[^?#]+(?:[?#].*)?)$/i)?.[1]
  if (bundledAssetPath) {
    return resolveBundledAssetURL(bundledAssetPath)
  }
  if (/^(https?:|data:|blob:|kition-workspace:)/i.test(path)) {
    return path
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return isDesktopRuntime() ? `${getDesktopBackendOrigin()}${normalizedPath}` : normalizedPath
}

export function getDesktopBackendHealthURL() {
  return `${getDesktopBackendOrigin()}${backendHealthPath}`
}

export async function waitForDesktopBackendReady(timeoutMs = 15000) {
  if (!isDesktopRuntime()) {
    return true
  }

  if (!desktopBackendReadyPromise) {
    desktopBackendReadyPromise = (async () => {
      const deadline = Date.now() + timeoutMs
      let hasRetriedStart = false

      while (Date.now() < deadline) {
        try {
          const status = await getDesktopBackendStatus()
          if (status?.launch_mode === 'skip_api') {
            return true
          }
          if (!hasRetriedStart && status && !status.running) {
            hasRetriedStart = true
            await retryDesktopBackendStart().catch(() => null)
            continue
          }
        } catch {
          // Fall through to the health check retry loop.
        }

        try {
          const response = await fetch(getDesktopBackendHealthURL(), { method: 'GET' })
          if (response.ok) {
            return true
          }
        } catch {
          // Backend is still booting. Retry shortly.
        }

        if (!hasRetriedStart) {
          hasRetriedStart = true
          await retryDesktopBackendStart().catch(() => null)
        }

        await new Promise((resolve) => window.setTimeout(resolve, 300))
      }
      return false
    })()
  }

  try {
    return await desktopBackendReadyPromise
  } finally {
    desktopBackendReadyPromise = null
  }
}

export async function getDesktopInfo(): Promise<DesktopInfo | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.DesktopInfo) {
    return null
  }
  const info = await bridge.DesktopInfo()
  return {
    ...info,
    platform: normalizeDesktopPlatform(info.platform),
  }
}

export async function getDesktopBackendStatus(): Promise<DesktopBackendStatus | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.BackendStatus) {
    return null
  }
  return bridge.BackendStatus()
}

export async function retryDesktopBackendStart(): Promise<DesktopBackendStatus | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.RetryBackendStart) {
    return null
  }
  return bridge.RetryBackendStart()
}

export async function initializeDesktopBootstrap() {
  const bridge = getDesktopBridge()
  if (!bridge?.BootstrapInitialize) {
    throw new Error('desktop bootstrap is unavailable')
  }
  return bridge.BootstrapInitialize()
}

export async function createDesktopBootstrapAttestation(request: BootstrapAttestationRequest) {
  const bridge = getDesktopBridge()
  if (!bridge?.BootstrapCreateAttestation) {
    throw new Error('desktop bootstrap attestation is unavailable')
  }
  return bridge.BootstrapCreateAttestation(request)
}

export async function getDesktopBootstrapStatus() {
  const bridge = getDesktopBridge()
  if (!bridge?.BootstrapStatus) {
    throw new Error('desktop bootstrap status is unavailable')
  }
  return bridge.BootstrapStatus()
}

export async function openExternalURL(url: string) {
  const bridge = getDesktopBridge()
  if (bridge?.OpenExternalURL) {
    await bridge.OpenExternalURL(url)
    return
  }

  if (bridge?.BrowserOpenURL) {
    bridge.BrowserOpenURL(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function submitFeedbackReport(request: FeedbackReportSubmissionRequest) {
  const bridge = getDesktopBridge()
  if (bridge?.SubmitFeedback) {
    return bridge.SubmitFeedback(request)
  }

  const accessToken = String(request.access_token || '').trim()
  const path = accessToken ? '/api/issue-reports' : '/api/issue-reports/anonymous'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`
  }
  const response = await fetch(`https://kition.ai${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      schema_version: 1,
      requestId: '',
      taskId: '',
      runtimeMode: 'hosted',
      errorCode: '',
      errorMessage: '',
      description: request.description,
      contactEmail: request.contact_email || '',
      timestamp: new Date().toISOString(),
      via: 'web',
    }),
  })
  const body = await response.json().catch(() => ({})) as {
    data?: { ticketId?: string; accepted_at?: string }
    error?: string
  }
  if (!response.ok) {
    throw new Error(body.error || `feedback submission failed (${response.status})`)
  }
  const ticketId = String(body.data?.ticketId || '').trim()
  if (!ticketId) {
    throw new Error('feedback service returned an invalid response')
  }
  return {
    ticket_id: ticketId,
    accepted_at: String(body.data?.accepted_at || ''),
  }
}

export async function showDesktopNotification(title: string, message: string) {
  const bridge = getDesktopBridge()
  if (bridge?.ShowNotification) {
    await bridge.ShowNotification(title, message)
  }
}

export async function triggerWindowAction(action: string) {
  const bridge = getDesktopBridge()
  if (!bridge?.WindowAction) {
    return
  }
  await bridge.WindowAction(action)
}

export async function openRuntimePath(kind: 'data' | 'cache' | 'logs' | 'exports') {
  const bridge = getDesktopBridge()
  if (!bridge?.OpenRuntimePath) {
    return
  }
  await bridge.OpenRuntimePath(kind)
}

export function registerDesktopMenuHandler(handler: (payload: { action?: string; profileId?: string }) => void) {
  const bridge = getDesktopBridge()
  if (!bridge?.EventsOn) {
    return
  }

  bridge.EventsOn('desktop:menu', (payload: { action?: string; profileId?: string }) => {
    if (payload?.action) {
      handler(payload)
    }
  })
}
