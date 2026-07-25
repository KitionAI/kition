import {
  createDefaultDesktopProxyState,
  type DesktopProxySavePayload,
  type DesktopProxyState,
  type DesktopProxyTestResult,
} from '../types/desktopProxy'

type Bridge = {
  ProxyGet?: () => Promise<DesktopProxyState>
  ProxySave?: (payload: DesktopProxySavePayload) => Promise<{ state: DesktopProxyState; requiresRestart: boolean }>
  ProxyTest?: (payload?: DesktopProxySavePayload) => Promise<DesktopProxyTestResult>
  ProxyRestartBackend?: () => Promise<{ ok: boolean; message?: string }>
}

function bridge(): Bridge | null {
  return ((globalThis as unknown as { kitionDesktop?: Bridge }).kitionDesktop) ?? null
}

const UNSUPPORTED_TEST: DesktopProxyTestResult = { ok: false, message: 'web preview: not supported' }

/**
 * Renderer's view of the proxy config. The password is never returned over
 * IPC — `hasPassword` is the boolean affordance the form uses to show
 * "stored (•••)" instead of an empty password field.
 */
export async function getProxyState(): Promise<DesktopProxyState> {
  const result = await bridge()?.ProxyGet?.()
  return result ?? createDefaultDesktopProxyState()
}

/**
 * Save + apply. The main process decides whether the backend needs a restart
 * (based on which fields changed) and returns it as `requiresRestart`. The
 * caller is responsible for confirming with the user before calling
 * {@link restartBackend} — we never restart silently.
 */
export async function saveProxyState(
  payload: DesktopProxySavePayload,
): Promise<{ state: DesktopProxyState; requiresRestart: boolean }> {
  const result = await bridge()?.ProxySave?.(payload)
  if (!result) {
    return { state: createDefaultDesktopProxyState(), requiresRestart: false }
  }
  return result
}

/**
 * TCP-probe the proxy without actually tunneling traffic. Takes an optional
 * override config so the form can let the user "test before save".
 */
export async function testProxy(payload?: DesktopProxySavePayload): Promise<DesktopProxyTestResult> {
  return (await bridge()?.ProxyTest?.(payload)) ?? UNSUPPORTED_TEST
}

/**
 * Restart the Go API subprocess so it picks up the new proxy env vars. The
 * UI must only call this after explicit user confirmation.
 */
export async function restartBackend(): Promise<{ ok: boolean; message?: string }> {
  return (await bridge()?.ProxyRestartBackend?.()) ?? { ok: false, message: 'web preview: not supported' }
}
