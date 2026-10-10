import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
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
import { PHOTO_MENU_ORDER } from './photoTools'

type MenuNode = {
  label: string
  commands: KitsCommandView[]
  submenus: Map<string, KitsCommandView[]>
}

/** Groups commands by their first menu segment, and the rest by their second. */
function buildPhotoMenus(commands: readonly KitsCommandView[]) {
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
    const index = PHOTO_MENU_ORDER.indexOf(label as (typeof PHOTO_MENU_ORDER)[number])
    return index < 0 ? PHOTO_MENU_ORDER.length : index
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

function CommandItem({ command, onRun }: { command: KitsCommandView; onRun: (command: KitsCommandView) => void }) {
  return (
    <MenuBarItem
      disabled={!command.enabled}
      shortcut={shortcutLabel(command.shortcut)}
      onSelect={() => onRun(command)}
      data-testid={`photo-menu-command-${command.id}`}
    >
      {command.title}
    </MenuBarItem>
  )
}

type PhotoMenuBarProps = {
  commands: readonly KitsCommandView[]
  onRun: (command: KitsCommandView) => void
  /** Called when a menu opens, so enabled states can be refreshed. */
  onOpen: () => void
}

/** The editor's menus, built from the commands the kit contributes, in Kition's menu style. */
export function PhotoMenuBar({ commands, onRun, onOpen }: PhotoMenuBarProps) {
  const { t } = useTranslation('workspace')
  const menus = useMemo(() => buildPhotoMenus(commands), [commands])
  return (
    <MenuBar
      className="h-9 shrink-0 border-b border-border px-2"
      onValueChange={(value) => {
        if (value) onOpen()
      }}
      data-testid="photo-menu-bar"
    >
      {menus.map((menu) => (
        <MenuBarMenu key={menu.label}>
          <MenuBarTrigger data-testid={`photo-menu-${menu.label}`}>{t(`photoKit.menu.${menu.label}`, { defaultValue: menu.label })}</MenuBarTrigger>
          <MenuBarContent>
            {menu.commands.map((command) => <CommandItem key={command.id} command={command} onRun={onRun} />)}
            {menu.commands.length && menu.submenus.size ? <MenuBarSeparator /> : null}
            {[...menu.submenus.entries()].map(([label, items]) => (
              <MenuBarSub key={label}>
                <MenuBarSubTrigger>{label}</MenuBarSubTrigger>
                <MenuBarSubContent>
                  {items.map((command) => <CommandItem key={command.id} command={command} onRun={onRun} />)}
                </MenuBarSubContent>
              </MenuBarSub>
            ))}
          </MenuBarContent>
        </MenuBarMenu>
      ))}
    </MenuBar>
  )
}
