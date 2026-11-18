import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OpenSourceLicenses } from './OpenSourceLicenses'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null
let fetched: string[] = []

async function settle() {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function waitFor(condition: () => boolean) {
  for (let index = 0; index < 50 && !condition(); index += 1) await settle()
  expect(condition()).toBe(true)
}

function tab(name: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((element) => element.textContent === name)!
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
  await settle()
}

describe('OpenSourceLicenses', () => {
  beforeEach(async () => {
    fetched = []
    // The kit packages the app serves under /kits/<kit>-ui/; the Board package lacks its NOTICE here.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetched.push(url)
      const match = /^\/kits\/([a-z]+)-ui\/(NOTICE|LICENSE)$/.exec(url)
      if (!match || (match[1] === 'board' && match[2] === 'NOTICE')) {
        return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response(`${match[1]} kit ${match[2]} text`, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(OpenSourceLicenses))
    })
    await settle()
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    container.remove()
    vi.unstubAllGlobals()
  })

  it("shows Kition's licence first", async () => {
    await waitFor(() => Boolean(container.querySelector('pre')))
    expect(container.textContent).toContain('Kition is licensed under the Apache License 2.0.')
    expect(container.querySelector('pre')!.textContent).toContain('Apache License')
  })

  it('shows the npm package and Rust crate notices', async () => {
    await click(tab('Third-party software'))
    await waitFor(() => Boolean(container.querySelector('pre')?.textContent?.includes('Rust Crate Inventory')))
    const notices = container.querySelector('pre')!.textContent!
    expect(notices).toContain('Package Inventory')
    expect(notices).toMatch(/^react \d/m)
    expect(notices).toMatch(/^tauri \d/m)
    expect(notices).toContain('Rust Crate License Texts')
  })

  it("shows each bundled kit's NOTICE and LICENSE from its package", async () => {
    await click(tab('Kits'))
    await waitFor(() => container.querySelectorAll('.kui-disclosure').length > 0)
    const doc = [...container.querySelectorAll<HTMLButtonElement>('.kui-disclosure-trigger')].find((element) => element.textContent?.startsWith('Doc kit '))!
    await click(doc)
    await waitFor(() => (container.textContent ?? '').includes('doc kit NOTICE text'))
    expect(container.textContent).toContain('doc kit LICENSE text')
    expect(fetched).toEqual(expect.arrayContaining(['/kits/doc-ui/NOTICE', '/kits/doc-ui/LICENSE']))

    const board = [...container.querySelectorAll<HTMLButtonElement>('.kui-disclosure-trigger')].find((element) => element.textContent?.startsWith('Board kit '))!
    await click(board)
    await waitFor(() => (container.textContent ?? '').includes('board kit LICENSE text'))
    expect(container.textContent).not.toContain('board kit NOTICE text')
  })
})
