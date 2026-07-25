import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowLauncherDecor } from './WorkflowLauncherDecor'

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
})

describe('WorkflowLauncherDecor', () => {
  it('renders the sample prompt bubble copy', async () => {
    await mount(createElement(WorkflowLauncherDecor, {}))
    expect(container.textContent.toUpperCase()).toContain('AUTO-SEND FOLLOW-UP REMINDERS')
  })

  it('is hidden on screens narrower than lg', async () => {
    await mount(createElement(WorkflowLauncherDecor, {}))
    const element = container.querySelector('[data-testid="workflow-launcher-decor"]')
    expect(element?.className).toMatch(/hidden\s+lg:flex|lg:flex.*hidden/)
  })
})
