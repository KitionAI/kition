const KEY = 'kition:update:dismissed-version'

export function dismissVersion(version: string): void {
  if (!version) return
  try { window.localStorage.setItem(KEY, version) } catch {}
}

export function isVersionDismissed(version: string | undefined): boolean {
  if (!version) return false
  try { return window.localStorage.getItem(KEY) === version } catch { return false }
}

export function clearDismissedVersion(): void {
  try { window.localStorage.removeItem(KEY) } catch {}
}
