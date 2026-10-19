import { act } from 'react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Menu } from './Menu'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('Menu builder', () => {
  it('addItem returns this for chaining and stores items in order', () => {
    const menu = new Menu()
    const onSelect = vi.fn()
    const result = menu
      .addItem((i) => i.setTitle('Add link').setIcon('link').onSelect(onSelect))
      .addSeparator()
      .addItem((i) => i.setTitle('Cut').setIcon('scissors'))

    expect(result).toBe(menu)
    expect(menu.items).toHaveLength(3)
    expect(menu.items[0]).toMatchObject({ kind: 'item', title: 'Add link', icon: 'link' })
    expect(menu.items[1]).toMatchObject({ kind: 'separator' })
    expect(menu.items[2]).toMatchObject({ kind: 'item', title: 'Cut', icon: 'scissors' })
  })

  it('MenuItem.setSubmenu returns a new Menu instance and stores it', () => {
    const menu = new Menu()
    let captured: Menu | null = null
    menu.addItem((i) => {
      i.setTitle('Text format')
      captured = i.setSubmenu()
      captured.addItem((sub) => sub.setTitle('Bold'))
    })

    const top = menu.items[0]
    expect(top.kind).toBe('item')
    if (top.kind !== 'item') throw new Error('unreachable')
    expect(top.submenu).toBe(captured)
    expect(top.submenu?.items).toHaveLength(1)
  })

  it('setDisabled toggles the disabled flag', () => {
    const menu = new Menu()
    menu.addItem((i) => i.setTitle('Paste').setDisabled(true))
    const item = menu.items[0]
    if (item.kind !== 'item') throw new Error('unreachable')
    expect(item.disabled).toBe(true)
  })

  it('shortcut hint stores keyboard shortcut for right-aligned label', () => {
    const menu = new Menu()
    menu.addItem((i) => i.setTitle('Bold').setShortcut('Cmd+B'))
    const item = menu.items[0]
    if (item.kind !== 'item') throw new Error('unreachable')
    expect(item.shortcut).toBe('Cmd+B')
  })
})

describe('Menu.showAtMouseEvent', () => {
  afterEach(() => {
    document.querySelectorAll('.document-menu-portal').forEach((n) => n.remove())
  })

  it('extracts clientX/clientY, prevents default, and shows the menu', async () => {
    const menu = new Menu().addItem((i) => i.setTitle('X'))
    const event = new MouseEvent('contextmenu', { clientX: 123, clientY: 456 })
    const prevent = vi.spyOn(event, 'preventDefault')

    await act(async () => {
      menu.showAtMouseEvent(event)
    })

    expect(prevent).toHaveBeenCalled()
    const portal = document.querySelector('.document-menu-portal')
    expect(portal).not.toBeNull()
    expect(portal?.querySelector('.document-menu')).not.toBeNull()

    await act(async () => {
      menu.hide()
    })
  })

  it('returns the menu for chaining', async () => {
    const menu = new Menu().addItem((i) => i.setTitle('X'))
    const event = new MouseEvent('contextmenu', { clientX: 0, clientY: 0 })
    let result: Menu
    await act(async () => {
      result = menu.showAtMouseEvent(event)
    })
    expect(result!).toBe(menu)
    await act(async () => {
      menu.hide()
    })
  })
})

describe('Menu lifecycle', () => {
  afterEach(() => {
    document.querySelectorAll('.document-menu-portal').forEach((n) => n.remove())
  })

  it('showAtPosition mounts to document.body and hide removes it', async () => {
    const menu = new Menu()
    menu.addItem((i) => i.setTitle('Test'))

    await act(async () => {
      menu.showAtPosition({ x: 50, y: 50 })
    })
    expect(document.querySelectorAll('.document-menu-portal').length).toBe(1)
    expect(document.querySelector('.document-menu-item')?.textContent).toContain('Test')

    await act(async () => {
      menu.hide()
    })
    expect(document.querySelectorAll('.document-menu-portal').length).toBe(0)
  })

  it('opening a second top-level menu closes the first', async () => {
    const a = new Menu().addItem((i) => i.setTitle('A'))
    const b = new Menu().addItem((i) => i.setTitle('B'))

    await act(async () => {
      a.showAtPosition({ x: 0, y: 0 })
    })
    await act(async () => {
      b.showAtPosition({ x: 0, y: 0 })
    })

    const portals = document.querySelectorAll('.document-menu-portal')
    expect(portals).toHaveLength(1)
    expect(portals[0].textContent).toContain('B')
    await act(async () => {
      b.hide()
    })
  })
})
