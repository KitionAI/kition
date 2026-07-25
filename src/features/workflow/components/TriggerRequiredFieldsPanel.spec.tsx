import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { TriggerRequiredFieldsPanel } from './TriggerRequiredFieldsPanel'

let container: HTMLDivElement; let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

// React's controlled-input wrapper installs an internal __valueTracker on
// HTMLInputElement.{value,checked}. Assigning the property directly (e.g.
// `checkbox.checked = true`) hits React's monkey-patched setter, which
// records the new value as "already seen" — so when the synthetic change
// event fires, React diffs current-vs-tracked, sees no delta, and skips
// the onChange handler. The native setter (the original descriptor on
// the prototype) bypasses React's wrapper, leaving the tracker stale and
// letting React's synthetic event fire.
const nativeCheckedSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'checked',
)!.set!

async function clickCheckbox(input: HTMLInputElement, next: boolean) {
  await act(async () => {
    nativeCheckedSetter.call(input, next)
    input.dispatchEvent(new Event('click', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const schemaFixture: TableSchema = {
  id: 'tbl_1',
  name: 'Leads',
  fields: [
    { id: 'fld_name', name: 'Name', type: 'text' },
    { id: 'fld_priority', name: 'Priority', type: 'single_select' },
    { id: 'fld_due', name: 'Due', type: 'date' },
  ],
}

describe('TriggerRequiredFieldsPanel', () => {
  it('renders an empty-state prompt when no table is bound (schema null)', async () => {
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: [],
      schema: null,
      onChange: () => {},
    }))
    const panel = container.querySelector('[data-testid="workflow-home-trigger-required-fields"]')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('data-state')).toBe('no-schema')
    expect(panel?.textContent).toContain('Pick a table above')
    // No checkbox list rendered when schema is null.
    expect(container.querySelector('[data-testid="workflow-home-trigger-required-fields-list"]')).toBeNull()
  })

  it('renders an unchecked checkbox + type icon + label for every schema field', async () => {
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: [],
      schema: schemaFixture,
      onChange: () => {},
    }))
    for (const field of schemaFixture.fields) {
      const row = container.querySelector(`[data-testid="workflow-home-trigger-required-fields-row-${field.id}"]`)
      expect(row, `row for ${field.id}`).not.toBeNull()
      expect(row?.getAttribute('data-checked')).toBe('false')
      expect(row?.textContent).toContain(field.name)
    }
    // No stale section when value is empty.
    expect(container.querySelector('[data-testid="workflow-home-trigger-required-fields-stale"]')).toBeNull()
  })

  it('marks rows checked when their id appears in value', async () => {
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: ['fld_priority'],
      schema: schemaFixture,
      onChange: () => {},
    }))
    const checked = container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-row-fld_priority"]',
    )
    expect(checked?.getAttribute('data-checked')).toBe('true')
    const unchecked = container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-row-fld_name"]',
    )
    expect(unchecked?.getAttribute('data-checked')).toBe('false')
  })

  it('emits an additive onChange when an unchecked box is ticked', async () => {
    const onChange = vi.fn()
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: ['fld_priority'],
      schema: schemaFixture,
      onChange,
    }))
    const checkbox = container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-checkbox-fld_due"]',
    ) as HTMLInputElement
    await clickCheckbox(checkbox, true)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(['fld_priority', 'fld_due'])
  })

  it('emits a subtractive onChange when a checked box is unticked', async () => {
    const onChange = vi.fn()
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: ['fld_priority', 'fld_due'],
      schema: schemaFixture,
      onChange,
    }))
    const checkbox = container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-checkbox-fld_priority"]',
    ) as HTMLInputElement
    await clickCheckbox(checkbox, false)
    expect(onChange).toHaveBeenCalledWith(['fld_due'])
  })

  it('clears the gate to [] when the last checked field is unticked', async () => {
    const onChange = vi.fn()
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: ['fld_priority'],
      schema: schemaFixture,
      onChange,
    }))
    const checkbox = container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-checkbox-fld_priority"]',
    ) as HTMLInputElement
    await clickCheckbox(checkbox, false)
    // Empty list is the contract for "disable gate" — the patch layer
    // forwards it as `[]` which the backend interprets as clear.
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('does not emit when disabled', async () => {
    const onChange = vi.fn()
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: [],
      schema: schemaFixture,
      onChange,
      disabled: true,
    }))
    const checkbox = container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-checkbox-fld_name"]',
    ) as HTMLInputElement
    expect(checkbox?.disabled).toBe(true)
    // Even if a change event is forced through (browsers don't fire
    // change on a disabled input but the panel guards defensively),
    // nothing should propagate.
    await clickCheckbox(checkbox, true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders stale (removed) selected fields in a separate block with a Remove button', async () => {
    const onChange = vi.fn()
    await mount(createElement(TriggerRequiredFieldsPanel, {
      // fld_ghost no longer exists on the schema.
      value: ['fld_priority', 'fld_ghost'],
      schema: schemaFixture,
      onChange,
    }))
    const stale = container.querySelector('[data-testid="workflow-home-trigger-required-fields-stale"]')
    expect(stale).not.toBeNull()
    expect(stale?.textContent).toContain('fld_ghost')
    expect(stale?.textContent).toContain('(removed)')

    // Live row for fld_priority still rendered above.
    expect(container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-row-fld_priority"]',
    )).not.toBeNull()
    // Live row for fld_ghost is NOT in the main list.
    expect(container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-row-fld_ghost"]',
    )).toBeNull()

    // Clicking the explicit "Remove gate" button drops it from value.
    const removeBtn = container.querySelector(
      '[data-testid="workflow-home-trigger-required-fields-stale-remove-fld_ghost"]',
    ) as HTMLButtonElement
    await act(async () => { removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onChange).toHaveBeenCalledWith(['fld_priority'])
  })

  it('renders the empty-schema message when the table has no fields yet', async () => {
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: [],
      schema: { id: 'tbl_empty', name: 'Empty', fields: [] },
      onChange: () => {},
    }))
    const empty = container.querySelector('[data-testid="workflow-home-trigger-required-fields-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('has no fields yet')
    expect(container.querySelector('[data-testid="workflow-home-trigger-required-fields-list"]')).toBeNull()
  })

  it('shows an "Optional" badge when zero fields are ticked', async () => {
    await mount(createElement(TriggerRequiredFieldsPanel, {
      value: [],
      schema: schemaFixture,
      onChange: () => {},
    }))
    const badge = container.querySelector('[data-testid="workflow-home-trigger-required-fields-count"]')
    expect(badge?.textContent).toMatch(/Optional/)
    expect(badge?.textContent).toContain('0')
  })

  it('shows the count of live (non-stale) ticked fields', async () => {
    await mount(createElement(TriggerRequiredFieldsPanel, {
      // Two live + one stale should report "2 required", not 3.
      value: ['fld_priority', 'fld_due', 'fld_ghost'],
      schema: schemaFixture,
      onChange: () => {},
    }))
    const badge = container.querySelector('[data-testid="workflow-home-trigger-required-fields-count"]')
    expect(badge?.textContent).toContain('2')
    expect(badge?.textContent).toContain('required')
  })
})
