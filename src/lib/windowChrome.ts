import { triggerWindowAction } from '@/services/desktop'

const DRAG_EXCLUDE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="tab"], .document-tab, .workspace-agent-tab, [data-window-drag-exclude="true"]'

function shouldIgnoreWindowDoubleClick(target: EventTarget | null) {
  const element = target instanceof Element ? target : null
  return Boolean(element?.closest(DRAG_EXCLUDE_SELECTOR))
}

// macOS hiddenInset has no native double-click region in the title bar, so JS triggers maximize on double-clicks in the pseudo title bar.
// The topbar and the top of the sidebar share this region and this handler, so the upper-left double-click is always responsive.
export function handleDesktopChromeDoubleClick(event: { target: EventTarget | null }) {
  if (shouldIgnoreWindowDoubleClick(event.target)) {
    return
  }
  void triggerWindowAction('toggle-maximise')
}
