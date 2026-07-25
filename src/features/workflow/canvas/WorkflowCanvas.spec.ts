import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowCanvas } from './WorkflowCanvas'
import { NodeCard } from './NodeCard'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
})

async function mount(element: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(element)
    await Promise.resolve()
  })
}

function buildTwoNodes() {
  return [
    createElement(NodeCard, {
      key: 't',
      kind: 'trigger',
      rowLabel: 'Step 1',
      title: 'Trigger',
      description: 'desc',
      status: 'green',
    }),
    createElement(NodeCard, {
      key: 'a',
      kind: 'action',
      rowLabel: 'Step 2',
      title: 'Action',
      description: 'desc',
      status: 'red',
    }),
  ]
}

function readScalePercent(): number {
  const readout = container.querySelector('[data-testid="workflow-canvas-zoom-readout"]')
  if (!readout?.textContent) return NaN
  const match = readout.textContent.match(/(\d+)/)
  return match ? Number(match[1]) : NaN
}

describe('WorkflowCanvas', () => {
  it('renders nodes interleaved with insert points and an end cap', async () => {
    await mount(createElement(WorkflowCanvas, { children: buildTwoNodes() }))
    const nodes = container.querySelectorAll('[data-testid="workflow-canvas-node"]')
    expect(nodes).toHaveLength(2)
    // One insert point per node (after). Match the outer wrapper exactly so
    // the button + popover testids inside don't inflate the count.
    const inserts = container.querySelectorAll(
      '[data-testid="workflow-insert-1"], [data-testid="workflow-insert-2"]',
    )
    expect(inserts).toHaveLength(2)
    expect(container.querySelector('[data-testid="workflow-canvas-endcap"]')).toBeTruthy()
  })

  it('forwards click on an insert point through the popover and reports slot index + kind', async () => {
    const handle = vi.fn()
    await mount(
      createElement(WorkflowCanvas, {
        onInsertAt: handle,
        children: buildTwoNodes(),
      }),
    )
    // Open the popover for slot #1, open the node catalog, then pick a real
    // action. The catalog replaces the legacy one-click generic action.
    const insertButton = container.querySelector(
      '[data-testid="workflow-insert-1-button"]',
    ) as HTMLButtonElement
    await act(async () => {
      insertButton.click()
      await Promise.resolve()
    })
    const addAction = container.querySelector(
      '[data-testid="workflow-insert-1-add-action"]',
    ) as HTMLButtonElement
    expect(addAction).toBeTruthy()
    await act(async () => {
      addAction.click()
      await Promise.resolve()
    })
    const updateRecord = document.querySelector(
      '[data-node-type="update_record"]',
    ) as HTMLButtonElement
    expect(updateRecord).toBeTruthy()
    await act(async () => {
      updateRecord.click()
      await Promise.resolve()
    })
    expect(handle).toHaveBeenCalledWith(1, 'action', 'update_record')
  })

  it('renders zoom controls + readout starting at 100%', async () => {
    await mount(createElement(WorkflowCanvas, { children: buildTwoNodes() }))
    expect(container.querySelector('[data-testid="workflow-canvas-zoom-in"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="workflow-canvas-zoom-out"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="workflow-canvas-zoom-fit"]')).toBeTruthy()
    expect(readScalePercent()).toBe(100)
  })

  it('clicking the zoom-in button bumps the readout (and zoom-out brings it back)', async () => {
    await mount(createElement(WorkflowCanvas, { children: buildTwoNodes() }))
    const inBtn = container.querySelector(
      '[data-testid="workflow-canvas-zoom-in"]',
    ) as HTMLButtonElement
    const outBtn = container.querySelector(
      '[data-testid="workflow-canvas-zoom-out"]',
    ) as HTMLButtonElement
    await act(async () => {
      inBtn.click()
      await Promise.resolve()
    })
    // 1.0 * 1.2 = 1.2 -> 120%
    expect(readScalePercent()).toBe(120)
    await act(async () => {
      inBtn.click()
      await Promise.resolve()
    })
    // 1.2 * 1.2 = 1.44 -> 144%
    expect(readScalePercent()).toBe(144)
    await act(async () => {
      outBtn.click()
      outBtn.click()
      await Promise.resolve()
    })
    // back near 100%; rounding may yield 100 exactly.
    const pct = readScalePercent()
    expect(pct).toBeGreaterThanOrEqual(99)
    expect(pct).toBeLessThanOrEqual(101)
  })

  it('zoom is clamped at the configured min and max bounds', async () => {
    await mount(createElement(WorkflowCanvas, { children: buildTwoNodes() }))
    const inBtn = container.querySelector(
      '[data-testid="workflow-canvas-zoom-in"]',
    ) as HTMLButtonElement
    const outBtn = container.querySelector(
      '[data-testid="workflow-canvas-zoom-out"]',
    ) as HTMLButtonElement
    // Mash zoom in past the upper bound (2.0 / 200%).
    for (let i = 0; i < 30; i += 1) {
      await act(async () => {
        inBtn.click()
        await Promise.resolve()
      })
    }
    expect(readScalePercent()).toBeLessThanOrEqual(200)
    // Mash zoom out past the lower bound (0.25 / 25%).
    for (let i = 0; i < 60; i += 1) {
      await act(async () => {
        outBtn.click()
        await Promise.resolve()
      })
    }
    expect(readScalePercent()).toBeGreaterThanOrEqual(25)
  })

  it('the Fit button is wired (jsdom has no layout, so it resets to 100%)', async () => {
    await mount(createElement(WorkflowCanvas, { children: buildTwoNodes() }))
    const inBtn = container.querySelector(
      '[data-testid="workflow-canvas-zoom-in"]',
    ) as HTMLButtonElement
    const fitBtn = container.querySelector(
      '[data-testid="workflow-canvas-zoom-fit"]',
    ) as HTMLButtonElement
    await act(async () => {
      inBtn.click()
      inBtn.click()
      await Promise.resolve()
    })
    expect(readScalePercent()).toBeGreaterThan(100)
    await act(async () => {
      fitBtn.click()
      await Promise.resolve()
    })
    // Without measurable layout fit() falls back to identity (100%).
    expect(readScalePercent()).toBe(100)
  })

  it('content layer applies a CSS transform reflecting the current scale + translate', async () => {
    await mount(createElement(WorkflowCanvas, { children: buildTwoNodes() }))
    const content = container.querySelector(
      '[data-testid="workflow-canvas-content"]',
    ) as HTMLElement
    expect(content).toBeTruthy()
    // Initial transform — scale(1) with default 24,24 translate.
    expect(content.style.transform).toMatch(/scale\(1\)/)
    expect(content.style.transform).toMatch(/translate3d\(24px, 24px, 0\)/)
    // After a zoom-in click the transform reflects the new scale.
    const inBtn = container.querySelector(
      '[data-testid="workflow-canvas-zoom-in"]',
    ) as HTMLButtonElement
    await act(async () => {
      inBtn.click()
      await Promise.resolve()
    })
    expect(content.style.transform).toMatch(/scale\(1\.2\)/)
  })
})
