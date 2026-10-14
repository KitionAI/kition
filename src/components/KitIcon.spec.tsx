import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { KIT_ICON_IDS, KitIcon, kitIconComponent } from './KitIcon'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
})

async function render(element: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(element)
  })
  return container.querySelector('img')!
}

describe('KitIcon', () => {
  it('lists the kits', () => {
    expect(KIT_ICON_IDS).toEqual([
      'document', 'word', 'table', 'sheet', 'board', 'slide', 'design', 'layout',
      'vector', 'photo', 'effect', 'film', 'pdf', 'cad',
    ])
  })

  it('renders the kit svg as a decorative image', async () => {
    const image = await render(createElement(KitIcon, { kit: 'slide', className: 'size-4' }))
    expect(image.getAttribute('src')).toBe('/kit-icons/slide.svg')
    expect(image.getAttribute('alt')).toBe('')
    expect(image.dataset.kitIcon).toBe('slide')
    expect(image.className).toContain('size-4')
  })

  it('binds one stable component per kit', async () => {
    expect(kitIconComponent('table')).toBe(kitIconComponent('table'))
    const Bound = kitIconComponent('table')
    const image = await render(createElement(Bound, { className: 'size-3.5', 'aria-hidden': 'true' }))
    expect(image.getAttribute('src')).toBe('/kit-icons/table.svg')
    expect(image.getAttribute('aria-hidden')).toBe('true')
  })
})
