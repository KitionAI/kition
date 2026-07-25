import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

import { MenuRenderer } from './MenuRenderer'

export type MenuPosition = { x: number; y: number }

export type MenuEntry =
  | {
      kind: 'item'
      title: string
      icon?: string
      shortcut?: string
      disabled?: boolean
      warning?: boolean
      onSelect?: () => unknown
      submenu?: Menu
    }
  | { kind: 'separator' }

export class MenuItem {
  // We mutate the underlying entry in place so the parent Menu's `items` array
  // always reflects the latest config without needing a flush step.
  constructor(private readonly entry: Extract<MenuEntry, { kind: 'item' }>) {}

  setTitle(title: string): this {
    this.entry.title = title
    return this
  }

  setIcon(icon: string): this {
    this.entry.icon = icon
    return this
  }

  setShortcut(shortcut: string): this {
    this.entry.shortcut = shortcut
    return this
  }

  setDisabled(disabled: boolean): this {
    this.entry.disabled = disabled
    return this
  }

  setWarning(warning: boolean): this {
    this.entry.warning = warning
    return this
  }

  onSelect(callback: () => unknown): this {
    this.entry.onSelect = callback
    return this
  }

  setSubmenu(): Menu {
    const submenu = new Menu()
    this.entry.submenu = submenu
    return submenu
  }
}

let currentMenu: Menu | null = null

export class Menu {
  readonly items: MenuEntry[] = []

  private portal: HTMLDivElement | null = null
  private root: Root | null = null

  addItem(configure: (item: MenuItem) => void): this {
    const entry: Extract<MenuEntry, { kind: 'item' }> = { kind: 'item', title: '' }
    this.items.push(entry)
    configure(new MenuItem(entry))
    return this
  }

  addSeparator(): this {
    this.items.push({ kind: 'separator' })
    return this
  }

  showAtMouseEvent(event: MouseEvent): this {
    event.preventDefault()
    return this.showAtPosition({ x: event.clientX, y: event.clientY })
  }

  showAtPosition(position: MenuPosition): this {
    if (currentMenu && currentMenu !== this) currentMenu.hide()
    currentMenu = this

    if (!this.portal) {
      this.portal = document.createElement('div')
      this.portal.className = 'document-menu-portal'
      document.body.appendChild(this.portal)
    }
    if (!this.root) this.root = createRoot(this.portal)

    const root = this.root
    flushSync(() => {
      root.render(
        createElement(MenuRenderer, {
          menu: this,
          position,
          onClose: () => this.hide(),
        }),
      )
    })
    return this
  }

  hide(): void {
    if (currentMenu === this) currentMenu = null
    if (this.root) {
      this.root.unmount()
      this.root = null
    }
    if (this.portal) {
      this.portal.remove()
      this.portal = null
    }
  }
}
