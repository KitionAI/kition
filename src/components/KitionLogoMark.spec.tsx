import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { KitionLogoMark } from './KitionLogoMark'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  delete (window as typeof window & { kitionDesktop?: unknown }).kitionDesktop
})

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(createElement(KitionLogoMark, { className: 'size-10' }))
  })
  return container.querySelector('img')!
}

describe('KitionLogoMark', () => {
  it('uses the web path outside the desktop shell', async () => {
    const image = await render()
    expect(image.getAttribute('src')).toBe('/logo-mark.png')
    expect(image.alt).toBe('Kition')
  })

  it('falls back to the web path once when the bundled protocol cannot load', async () => {
    Object.assign(window, { kitionDesktop: { shell: 'electron' } })
    const image = await render()
    expect(image.getAttribute('src')).toBe('kition-bundled://assets/logo-mark.png')
    await act(async () => {
      image.dispatchEvent(new Event('error'))
    })
    expect(image.getAttribute('src')).toBe('/logo-mark.png')
    await act(async () => {
      image.dispatchEvent(new Event('error'))
    })
    expect(image.getAttribute('src')).toBe('/logo-mark.png')
  })
})
