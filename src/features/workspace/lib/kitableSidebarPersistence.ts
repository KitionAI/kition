const kitableSidebarCollapsedStorageKey = 'kition.workspace.kitable-sidebar.collapsed.v1'

export function readKitableSidebarCollapsed(defaultCollapsed = true) {
  if (typeof window === 'undefined') {
    return defaultCollapsed
  }

  const storedValue = window.localStorage.getItem(kitableSidebarCollapsedStorageKey)
  if (storedValue === 'true') return true
  if (storedValue === 'false') return false
  return defaultCollapsed
}

export function writeKitableSidebarCollapsed(collapsed: boolean) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(kitableSidebarCollapsedStorageKey, String(collapsed))
}
