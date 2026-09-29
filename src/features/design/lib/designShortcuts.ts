/** Shortcut labels for tooltips, written the way the platform shows them. */
export function designShortcutLabel(combo: string, platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  const mac = /mac|iphone|ipad/i.test(platform)
  return combo
    .split('+')
    .map((part) => {
      switch (part.trim().toLowerCase()) {
        case 'mod':
          return mac ? '⌘' : 'Ctrl'
        case 'alt':
          return mac ? '⌥' : 'Alt'
        case 'shift':
          return mac ? '⇧' : 'Shift'
        default:
          return part.trim().length === 1 ? part.trim().toUpperCase() : part.trim()
      }
    })
    .join(mac ? '' : '+')
}

/** A tooltip that names the action and its shortcut. */
export function designTooltip(label: string, combo: string, platform?: string): string {
  return `${label} (${designShortcutLabel(combo, platform)})`
}
