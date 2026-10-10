import { useMemo } from 'react'
import {
  MenuBar,
  MenuBarContent,
  MenuBarItem,
  MenuBarMenu,
  MenuBarSeparator,
  MenuBarSub,
  MenuBarSubContent,
  MenuBarSubTrigger,
  MenuBarTrigger,
} from '@/components/MenuBar'
import type { KitsCommandView } from '@/api/kits'

type MenuNode = {
  label: string
  commands: KitsCommandView[]
  submenus: Map<string, KitsCommandView[]>
}

/** Groups commands by their first menu segment, and the rest by their second, in `order`. */
function buildMenus(commands: readonly KitsCommandView[], order: readonly string[]) {
  const menus = new Map<string, MenuNode>()
  for (const command of commands) {
    const [top, sub] = command.menu
    if (!top) continue
    const node = menus.get(top) ?? { label: top, commands: [], submenus: new Map() }
    if (sub) {
      const items = node.submenus.get(sub) ?? []
      items.push(command)
      node.submenus.set(sub, items)
    } else {
      node.commands.push(command)
    }
    menus.set(top, node)
  }
  const rank = (label: string) => {
    const index = order.indexOf(label)
    return index < 0 ? order.length : index
  }
  return [...menus.values()].sort((a, b) => rank(a.label) - rank(b.label))
}

function shortcutLabel(shortcut: string | null) {
  if (!shortcut) return undefined
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  return mac
    ? shortcut.replace(/Cmd\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥').replace(/Ctrl\+/g, '⌃')
    : shortcut.replace(/Cmd\+/g, 'Ctrl+')
}

function CommandItem({ command, onRun, testId }: { command: KitsCommandView; onRun: (command: KitsCommandView) => void; testId: string }) {
  return (
    <MenuBarItem
      disabled={!command.enabled}
      shortcut={shortcutLabel(command.shortcut)}
      onSelect={() => onRun(command)}
      data-testid={`${testId}-command-${command.id}`}
    >
      {command.title}
    </MenuBarItem>
  )
}

type KitMenuBarProps = {
  commands: readonly KitsCommandView[]
  onRun: (command: KitsCommandView) => void
  /** Called when a menu opens, so enabled states can be refreshed. */
  onOpen: () => void
  /** Top-level menus in display order; others follow. */
  order: readonly string[]
  /** The shown name of a top-level menu (the kit's own label by default). */
  menuLabel?: (label: string) => string
  /** Prefix of the test ids: `<prefix>`, `<prefix>-<menu>`, `<prefix>-command-<id>`. */
  testId?: string
}

/** A kit editor's menus, built from the commands the kit contributes, in Kition's menu style. */
export function KitMenuBar({ commands, onRun, onOpen, order, menuLabel = (label) => label, testId = 'kit-menu' }: KitMenuBarProps) {
  const menus = useMemo(() => buildMenus(commands, order), [commands, order])
  return (
    <MenuBar
      className="h-9 shrink-0 border-b border-border px-2"
      onValueChange={(value) => {
        if (value) onOpen()
      }}
      data-testid={`${testId}-bar`}
    >
      {menus.map((menu) => (
        <MenuBarMenu key={menu.label}>
          <MenuBarTrigger data-testid={`${testId}-${menu.label}`}>{menuLabel(menu.label)}</MenuBarTrigger>
          <MenuBarContent>
            {menu.commands.map((command) => <CommandItem key={command.id} command={command} onRun={onRun} testId={testId} />)}
            {menu.commands.length && menu.submenus.size ? <MenuBarSeparator /> : null}
            {[...menu.submenus.entries()].map(([label, items]) => (
              <MenuBarSub key={label}>
                <MenuBarSubTrigger>{label}</MenuBarSubTrigger>
                <MenuBarSubContent>
                  {items.map((command) => <CommandItem key={command.id} command={command} onRun={onRun} testId={testId} />)}
                </MenuBarSubContent>
              </MenuBarSub>
            ))}
          </MenuBarContent>
        </MenuBarMenu>
      ))}
    </MenuBar>
  )
}
