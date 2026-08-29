import { expect, test, type Locator, type Page } from '@playwright/test'
import type { BoardElementRecord } from '../src/features/whiteboard/lib/boardRecords'

import {
  openWhiteboardFixture,
  readWhiteboardSnapshot,
} from './helpers/whiteboard'

const SHAPE_TYPES = [
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'hexagon',
  'pill',
  'parallelogram',
  'star',
  'cloud',
  'heart',
  'x-box',
  'check-box',
  'arrow-left',
  'arrow-up',
  'arrow-down',
  'arrow-right',
  'line',
  'frame',
] as const

const TEMPLATE_IDS = [
  'mind-map',
  'flowchart',
  'project-roadmap',
  'kanban-board',
  'meeting-retrospective',
  'presentation-storyboard',
] as const

test.beforeEach(async ({ page }) => {
  await openWhiteboardFixture(page)
})

test('opens the Board template center and creates an editable mind map', async ({ page }) => {
  await page.locator(
    '.document-private-heading .document-create-menu-anchor > button',
  ).click()
  await expect(page.getByTestId('workspace-create-board')).toBeVisible()
  await page.getByTestId('workspace-create-board').click()

  await expect(page.getByTestId('whiteboard-template-library-dialog')).toBeVisible()
  await expect(page.getByTestId('whiteboard-template-blank')).toBeVisible()
  await expect(page.getByTestId('whiteboard-template-create-mind-map')).toBeVisible()

  await page.getByTestId('whiteboard-template-create-mind-map').click()
  await expect(page.getByTestId('whiteboard-template-library-dialog')).toHaveCount(0)
  await expect(page.locator(
    '[data-testid="whiteboard-editor-pane"][data-board-path="Mind map.kiboard"]',
  )).toBeVisible()

  await expect.poll(async () => (await readWhiteboardSnapshot(page)).records.some((record) => (
    record.record_type === 'element'
      && record.kind === 'rectangle'
      && record.text === 'Research'
  ))).toBe(true)
  const snapshot = await readWhiteboardSnapshot(page)
  const researchRecord = snapshot.records.find((record): record is BoardElementRecord => (
    record.record_type === 'element'
      && record.kind === 'rectangle'
      && record.text === 'Research'
  ))
  if (!researchRecord || researchRecord.kind !== 'rectangle') {
    throw new Error('Mind map research node was not created')
  }
  const binding = snapshot.records.find((record) => (
    record.record_type === 'binding'
      && record.to_id === researchRecord.id
      && record.terminal === 'end'
  ))
  const connectorBefore = snapshot.records.find((record): record is BoardElementRecord => (
    record.record_type === 'element'
      && record.kind === 'connector'
      && record.id === binding?.from_id
  ))
  if (!connectorBefore || connectorBefore.kind !== 'connector') {
    throw new Error('Mind map research connector was not created')
  }

  const researchNode = page.locator(
    `[data-board-path="Mind map.kiboard"] [data-element-id="${researchRecord.id}"]`,
  )
  await page.locator(
    '[data-board-path="Mind map.kiboard"] [data-testid="whiteboard-svg-scene"]',
  ).click({ position: { x: 30, y: 260 } })
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).selectedElementIds)
    .toEqual([])
  await researchNode.hover()
  await expect(page.locator(
    `[data-mind-map-node-id="${researchRecord.id}"]`,
  ).getByTestId('whiteboard-mind-map-add')).toBeVisible()

  await researchNode.click()
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).selectedElementIds)
    .toEqual([researchRecord.id])
  await expect(page.getByTestId('whiteboard-connection-handle-east')).toHaveCount(0)

  const branchQuickControls = page.locator(
    `[data-mind-map-node-id="${researchRecord.id}"]`,
  )
  await expect(branchQuickControls.getByTestId('whiteboard-mind-map-collapse')).toBeVisible()
  await expect(branchQuickControls.getByTestId('whiteboard-mind-map-add')).toBeVisible()
  await branchQuickControls.getByTestId('whiteboard-mind-map-collapse').click()
  await expect.poll(async () => {
    const current = await elementRecord(page, researchRecord.id)
    return current?.kind === 'rectangle' ? current.mindMapCollapsed : null
  }).toBe(true)
  await expect(branchQuickControls.getByTestId('whiteboard-mind-map-expand')).toContainText('1')

  const questionRecord = snapshot.records.find((record) => (
    record.record_type === 'element'
      && record.kind === 'rectangle'
      && record.text === 'Open questions'
  ))
  if (!questionRecord) throw new Error('Mind map question node was not created')
  await expect(page.locator(
    `[data-board-path="Mind map.kiboard"] [data-element-id="${questionRecord.id}"]`,
  )).toHaveCount(0)

  await branchQuickControls.getByTestId('whiteboard-mind-map-expand').click()
  await expect(page.locator(
    `[data-board-path="Mind map.kiboard"] [data-element-id="${questionRecord.id}"]`,
  )).toBeVisible()

  await page.locator(
    '[data-board-path="Mind map.kiboard"] [data-testid="whiteboard-selection-move-area"]',
  ).dblclick()
  const editor = page.locator(
    '[data-board-path="Mind map.kiboard"] [data-testid="whiteboard-text-editor"]',
  )
  await expect(editor).toBeVisible()
  await editor.fill('Research updated')
  await editor.press('Enter')

  const researchBeforeDrag = await elementRecord(page, researchRecord.id)
  const connectorBeforeDrag = await elementRecord(page, connectorBefore.id)
  if (
    !researchBeforeDrag
    || researchBeforeDrag.kind !== 'rectangle'
    || !connectorBeforeDrag
    || connectorBeforeDrag.kind !== 'connector'
  ) throw new Error('Mind map drag baseline was not available')
  const bounds = await researchNode.boundingBox()
  if (!bounds) throw new Error('Mind map research node is not measurable')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 48, {
    steps: 8,
  })
  await page.mouse.up()

  await expect.poll(async () => {
    const current = await elementRecord(page, researchRecord.id)
    return current?.kind === 'rectangle'
      ? current.text === 'Research updated'
        && current.x > researchBeforeDrag.x + 60
        && current.y > researchBeforeDrag.y + 30
      : false
  }).toBe(true)
  const movedResearch = await elementRecord(page, researchRecord.id)
  if (!movedResearch || movedResearch.kind !== 'rectangle') {
    throw new Error('Mind map research node did not move')
  }
  const dragDelta = {
    x: movedResearch.x - researchBeforeDrag.x,
    y: movedResearch.y - researchBeforeDrag.y,
  }
  await expect.poll(async () => {
    const connector = await elementRecord(page, connectorBefore.id)
    return connector?.kind === 'connector' ? connector.end : null
  }).toEqual({
    x: connectorBeforeDrag.end.x + dragDelta.x,
    y: connectorBeforeDrag.end.y + dragDelta.y,
  })

  const beforeMindMapEdit = await readWhiteboardSnapshot(page)
  const topicRecord = beforeMindMapEdit.records.find((record): record is BoardElementRecord => (
    record.record_type === 'element'
      && record.kind === 'rectangle'
      && record.text === 'Central topic'
  ))
  if (!topicRecord || topicRecord.kind !== 'rectangle') {
    throw new Error('Mind map topic node was not created')
  }
  const mindNodeCount = beforeMindMapEdit.records.filter((record) => (
    record.record_type === 'element'
      && record.kind === 'rectangle'
      && record.shapeStyle === 'mind-node'
  )).length
  const connectorCount = beforeMindMapEdit.records.filter((record) => (
    record.record_type === 'element' && record.kind === 'connector'
  )).length
  const bindingCount = beforeMindMapEdit.records.filter((record) => (
    record.record_type === 'binding'
  )).length

  await page.locator(
    `[data-board-path="Mind map.kiboard"] [data-element-id="${topicRecord.id}"]`,
  ).click()
  await expect(page.getByTestId('whiteboard-mind-map-direction')).toBeVisible()
  const rootQuickControls = page.locator(
    `[data-mind-map-node-id="${topicRecord.id}"]`,
  )
  await expect(rootQuickControls.getByTestId('whiteboard-mind-map-add')).toBeVisible()

  await page.getByTestId('whiteboard-mind-map-direction').click()
  await page.getByTestId('whiteboard-mind-map-direction-down').click()
  await expect.poll(async () => {
    const current = await elementRecord(page, topicRecord.id)
    return current?.kind === 'rectangle' ? current.mindMapDirection : null
  }).toBe('down')
  await expect.poll(async () => {
    const current = await readWhiteboardSnapshot(page)
    const root = current.records.find((record): record is BoardElementRecord => (
      record.record_type === 'element' && record.id === topicRecord.id
    ))
    if (!root || root.kind !== 'rectangle') return false
    const rootCenterY = root.y + root.height / 2
    return current.records.filter((record): record is BoardElementRecord => (
      record.record_type === 'element'
        && record.kind === 'rectangle'
        && record.shapeStyle === 'mind-node'
        && record.id !== root.id
    )).every((record) => record.y + record.height / 2 > rootCenterY)
  }).toBe(true)

  await rootQuickControls.getByTestId('whiteboard-mind-map-add').click()
  await expect(editor).toBeVisible()
  await editor.fill('New branch')
  await editor.press('Enter')
  await expect.poll(async () => {
    const current = await readWhiteboardSnapshot(page)
    return {
      bindings: current.records.filter((record) => record.record_type === 'binding').length,
      connectors: current.records.filter((record) => (
        record.record_type === 'element' && record.kind === 'connector'
      )).length,
      mindNodes: current.records.filter((record) => (
        record.record_type === 'element'
          && record.kind === 'rectangle'
          && record.shapeStyle === 'mind-node'
      )).length,
      newBranch: current.records.some((record) => (
        record.record_type === 'element'
          && record.kind === 'rectangle'
          && record.text === 'New branch'
      )),
    }
  }).toEqual({
    bindings: bindingCount + 2,
    connectors: connectorCount + 1,
    mindNodes: mindNodeCount + 1,
    newBranch: true,
  })
})

test('drags an unselected element immediately without waiting for a long press', async ({ page }) => {
  const node = page.locator('[data-element-id="node-a"]')
  const bounds = await node.boundingBox()
  if (!bounds) throw new Error('Whiteboard element is not measurable')

  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 12,
    bounds.y + bounds.height / 2 + 8,
  )
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).interactionState)
    .toBe('translating')
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 90,
    bounds.y + bounds.height / 2 + 60,
    { steps: 8 },
  )
  await page.mouse.up()

  await expect.poll(async () => {
    const record = await elementRecord(page, 'node-a')
    return { x: record?.x, y: record?.y }
  }).toEqual({ x: 210, y: 200 })
})

test('pans with the wheel, zooms with ctrl-wheel, and creates text on canvas double click', async ({ page }) => {
  const scene = page.getByTestId('whiteboard-svg-scene')

  await scene.dispatchEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: 36,
    deltaY: 52,
  })
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).viewport).toEqual({
    x: 36,
    y: 52,
    zoom: 1,
  })

  await scene.dispatchEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 640,
    clientY: 380,
    ctrlKey: true,
    deltaX: 0,
    deltaY: -100,
  })
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).viewport.zoom)
    .toBeGreaterThan(1)

  await scene.dblclick({ position: { x: 900, y: 560 } })
  const editor = page.getByTestId('whiteboard-text-editor')
  await expect(editor).toBeVisible()
  await editor.fill('Double-click text')
  await editor.press('Enter')
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).records.some((record) => (
    record.record_type === 'element'
      && record.kind === 'text'
      && record.text === 'Double-click text'
  ))).toBe(true)
})

test('pressing Enter edits the single selected shape label', async ({ page }) => {
  await page.locator('[data-element-id="node-b"]').click()
  await page.keyboard.press('Enter')
  const editor = page.getByTestId('whiteboard-text-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAttribute('data-anchor', 'shape-center')
  await editor.fill('Edited with Enter')
  await editor.press('Enter')
  await expect(page.locator('[data-element-id="node-b"]')).toContainText('Edited with Enter')
})

test('holds Space for a temporary hand tool and restores the previous tool', async ({ page }) => {
  const scene = page.getByTestId('whiteboard-svg-scene')
  await page.keyboard.down('Space')
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).tool).toBe('hand')

  await dragOnScene(page, scene, { x: 900, y: 560 }, { x: 960, y: 600 })
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).viewport).toEqual({
    x: -60,
    y: -40,
    zoom: 1,
  })

  await page.keyboard.up('Space')
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).tool).toBe('select')
})

test('clicks every drawing tool and shape picker control', async ({ page }) => {
  for (const tool of ['select', 'hand', 'pen', 'highlight', 'eraser', 'connector', 'text', 'note'] as const) {
    await page.getByTestId(`whiteboard-tool-${tool}`).click()
    await expect.poll(async () => (await readWhiteboardSnapshot(page)).tool).toBe(tool)
  }

  for (const shapeType of SHAPE_TYPES) {
    await page.getByTestId('whiteboard-shape-menu-trigger').click()
    await page.getByTestId(`whiteboard-shape-${shapeType}`).click()
    await expect.poll(async () => (await readWhiteboardSnapshot(page)).shapeType).toBe(shapeType)
  }

  const scene = page.getByTestId('whiteboard-svg-scene')
  const before = await elementCount(page)

  await page.getByTestId('whiteboard-tool-rectangle').click()
  await dragOnScene(page, scene, { x: 300, y: 480 }, { x: 470, y: 580 })
  await expect.poll(() => elementCount(page)).toBe(before + 1)

  await page.getByTestId('whiteboard-tool-note').click()
  await clickScene(page, scene, { x: 520, y: 500 })
  await page.getByTestId('whiteboard-text-editor').fill('A multiline\nnote')
  await page.getByTestId('whiteboard-text-editor').press('Enter')

  await page.getByTestId('whiteboard-tool-text').click()
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).tool).toBe('text')
  await clickScene(page, scene, { x: 180, y: 520 })
  await page.getByTestId('whiteboard-text-editor').fill('Canvas label')
  await page.getByTestId('whiteboard-text-editor').press('Enter')

  await page.getByTestId('whiteboard-tool-pen').click()
  await dragOnScene(page, scene, { x: 260, y: 650 }, { x: 420, y: 690 })
  await page.getByTestId('whiteboard-tool-highlight').click()
  await dragOnScene(page, scene, { x: 470, y: 650 }, { x: 640, y: 690 })

  await page.getByTestId('whiteboard-tool-connector').click()
  await dragBetweenElements(page, 'node-a', 'node-b')

  const snapshot = await readWhiteboardSnapshot(page)
  expect(snapshot.records.filter((record) => record.record_type === 'element')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'rectangle' }),
      expect.objectContaining({ kind: 'text', text: 'Canvas label' }),
      expect.objectContaining({ kind: 'stroke' }),
      expect.objectContaining({ kind: 'connector' }),
    ]),
  )
})

test('inserts every editable Board template and removes it with one undo', async ({ page }) => {
  const initialCount = await elementCount(page)

  for (const templateId of TEMPLATE_IDS) {
    await page.getByTestId('whiteboard-template-trigger').click()
    await expect(page.getByTestId('whiteboard-template-gallery')).toBeVisible()
    await page.getByTestId(`whiteboard-template-${templateId}`).click()
    await expect(page.getByTestId('whiteboard-template-gallery')).toHaveCount(0)

    await expect.poll(() => elementCount(page)).toBeGreaterThan(initialCount)
    const snapshot = await readWhiteboardSnapshot(page)
    expect(snapshot.selectedElementIds).toHaveLength(1)
    expect(snapshot.records.some((record) => (
      record.record_type === 'element'
        && record.kind === 'rectangle'
        && record.shapeType === 'frame'
    ))).toBe(templateId !== 'mind-map')
    if (templateId === 'mind-map' || templateId === 'flowchart' || templateId === 'project-roadmap') {
      expect(snapshot.records.some((record) => (
        record.record_type === 'element' && record.kind === 'connector'
      ))).toBe(true)
      expect(snapshot.records.some((record) => record.record_type === 'binding')).toBe(true)
    }

    await page.getByTestId('whiteboard-undo').click()
    await expect.poll(() => elementCount(page)).toBe(initialCount)
  }
})

test('edits centered text and clicks every style control', async ({ page }) => {
  await page.locator('[data-element-id="node-a"]').click()
  await page.getByTestId('whiteboard-selection-move-area').dblclick()
  const editor = page.getByTestId('whiteboard-text-editor')
  await expect(editor).toHaveAttribute('data-anchor', 'shape-center')
  await editor.fill('Centered label')
  await editor.press('Enter')
  await expect(page.locator('[data-element-id="node-a"]')).toContainText('Centered label')

  for (const role of ['stroke', 'fill'] as const) {
    for (const color of ['ink', 'gray', 'purple', 'green', 'orange', 'red', 'yellow', 'blue', 'white']) {
      await page.getByTestId(`whiteboard-${role}-color-${color}`).click()
      await expect.poll(async () => {
        const record = await elementRecord(page, 'node-a')
        return record?.style?.[role === 'stroke' ? 'strokeColor' : 'fillColor']
      }).toBe(color)
    }
  }

  for (const fill of ['none', 'solid', 'semi', 'pattern']) {
    await page.getByTestId(`whiteboard-fill-${fill}`).click()
  }
  for (const dash of ['solid', 'dashed', 'dotted']) {
    await page.getByTestId(`whiteboard-dash-${dash}`).click()
  }
  for (const size of ['s', 'm', 'l', 'xl']) {
    await page.getByTestId(`whiteboard-size-${size}`).click()
  }
  const opacity = page.getByTestId('whiteboard-style-opacity')
  await opacity.evaluate((element) => {
    const input = element as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    setValue?.call(input, '55')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(opacity).toHaveValue('55')
  await opacity.dispatchEvent('pointerup')
  await expect.poll(async () => (await elementRecord(page, 'node-a'))?.style?.opacity).toBe(0.55)
})

test('clicks arrange actions, preferences, pages, and context menu behavior', async ({ page }) => {
  await page.locator('[data-element-id="node-a"]').click()
  await page.locator('[data-element-id="node-b"]').click({ modifiers: ['Shift'] })
  await page.locator('[data-element-id="node-c"]').click({
    modifiers: ['Shift'],
    position: { x: 20, y: 50 },
  })

  for (const action of [
    'whiteboard-distribute-horizontal',
    'whiteboard-distribute-vertical',
    'whiteboard-stack-horizontal',
    'whiteboard-stack-vertical',
    'whiteboard-rotate-counterclockwise',
    'whiteboard-rotate-clockwise',
    'whiteboard-flip-horizontal',
    'whiteboard-flip-vertical',
  ]) {
    await page.getByTestId('whiteboard-selection-more').click()
    await page.getByTestId(action).click()
  }

  await page.getByTestId('whiteboard-selection-more').click()
  await page.getByTestId('whiteboard-group-selection').click()
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).selectedElementIds.length).toBe(1)
  await page.getByTestId('whiteboard-selection-more').click()
  await page.getByTestId('whiteboard-ungroup-selection').click()

  for (const action of ['whiteboard-toggle-grid', 'whiteboard-toggle-snap', 'whiteboard-toggle-tool-lock']) {
    await page.getByTestId('whiteboard-more-actions').click()
    await page.getByTestId(action).click()
  }
  await expect(page.getByTestId('whiteboard-grid')).toHaveCount(0)

  const scene = page.getByTestId('whiteboard-svg-scene')
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).selectedElementIds.length)
    .toBeGreaterThan(0)
  await scene.click({ button: 'right', position: { x: 900, y: 600 } })
  await expect(page.getByTestId('whiteboard-context-menu')).toBeVisible()
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).selectedElementIds).toEqual([])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('whiteboard-context-menu')).toHaveCount(0)

  await page.getByTestId('whiteboard-page-trigger').click()
  await page.getByTestId('whiteboard-page-create').click()
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).records
    .filter((record) => record.record_type === 'page').length).toBe(2)
  await page.getByTestId('whiteboard-page-duplicate').click()
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).records
    .filter((record) => record.record_type === 'page').length).toBe(3)
  await page.getByTestId('whiteboard-page-delete').click()
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).records
    .filter((record) => record.record_type === 'page').length).toBe(2)

  const pageMenu = page.getByTestId('whiteboard-page-menu')
  if (await pageMenu.count()) await scene.click({ position: { x: 900, y: 650 } })
  await page.getByTestId('whiteboard-page-trigger').click()
  await expect(pageMenu).toBeVisible()
  await scene.click({ position: { x: 900, y: 650 } })
  await expect(pageMenu).toHaveCount(0)
})

test('rebinds connector terminals and changes connector presentation', async ({ page }) => {
  await page.getByTestId('whiteboard-tool-connector').click()
  await dragBetweenElements(page, 'node-a', 'node-b')
  const connector = (await readWhiteboardSnapshot(page)).records.find((record): record is BoardElementRecord => (
    record.record_type === 'element' && record.kind === 'connector'
  ))
  expect(connector?.record_type).toBe('element')

  await dragToElementPoint(
    page,
    page.getByTestId('whiteboard-connector-end-handle'),
    'node-c',
    { x: 20, y: 50 },
  )
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).records.some((record) => (
    record.record_type === 'binding'
      && record.from_id === connector?.id
      && record.terminal === 'end'
      && record.to_id === 'node-c'
  ))).toBe(true)

  await page.getByTestId('whiteboard-connector-type-curved').click()
  await page.getByTestId('whiteboard-connector-start-arrowhead').selectOption('dot')
  await page.getByTestId('whiteboard-connector-end-arrowhead').selectOption('arrow')
  await expect.poll(async () => {
    const record = await elementRecord(page, String(connector?.id))
    return [record?.connectorType, record?.startArrowhead, record?.endArrowhead]
  }).toEqual(['curved', 'dot', 'arrow'])
})

test('creates a bound elbow connector from a selected shape connection handle', async ({ page }) => {
  await page.locator('[data-element-id="node-c"]').click()
  for (const direction of ['north', 'east', 'south', 'west']) {
    await expect(page.getByTestId(`whiteboard-connection-handle-${direction}`)).toBeVisible()
  }

  const before = await readWhiteboardSnapshot(page)
  const existingConnectorIds = new Set(before.records.flatMap((record) => (
    record.record_type === 'element' && record.kind === 'connector' ? [record.id] : []
  )))
  const handleBounds = await page.getByTestId(
    'whiteboard-connection-handle-west',
  ).boundingBox()
  const targetBounds = await page.locator('[data-element-id="node-b"]').boundingBox()
  if (!handleBounds || !targetBounds) throw new Error('Quick connector targets are not measurable')
  await page.mouse.move(
    handleBounds.x + handleBounds.width / 2,
    handleBounds.y + handleBounds.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    targetBounds.x + targetBounds.width / 2,
    targetBounds.y + targetBounds.height / 2,
    { steps: 10 },
  )
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).interactionState)
    .toBe('connecting')
  await expect(page.locator('[data-element-id="node-b"]')).toHaveAttribute(
    'data-connection-target',
    'true',
  )
  await page.mouse.up()

  let connectorId = ''
  await expect.poll(async () => {
    const snapshot = await readWhiteboardSnapshot(page)
    const connector = snapshot.records.find((record): record is BoardElementRecord => (
      record.record_type === 'element'
        && record.kind === 'connector'
        && !existingConnectorIds.has(record.id)
    ))
    connectorId = connector?.id || ''
    return connector?.connectorType
  }).toBe('elbow')
  await expect.poll(async () => {
    const bindings = (await readWhiteboardSnapshot(page)).records.filter((record) => (
      record.record_type === 'binding' && record.from_id === connectorId
    ))
    return bindings.map((binding) => ({
      terminal: binding.record_type === 'binding' ? binding.terminal : undefined,
      toId: binding.record_type === 'binding' ? binding.to_id : undefined,
    }))
  }).toEqual(expect.arrayContaining([
    { terminal: 'start', toId: 'node-c' },
    { terminal: 'end', toId: 'node-b' },
  ]))
  await expect(page.locator(
    `[data-element-id="${connectorId}"] path`,
  ).last()).toHaveAttribute('d', / Q /)
})

async function elementCount(page: Page) {
  return (await readWhiteboardSnapshot(page)).records.filter((record) => (
    record.record_type === 'element'
  )).length
}

async function elementRecord(page: Page, id: string) {
  return (await readWhiteboardSnapshot(page)).records.find((record): record is BoardElementRecord => (
    record.record_type === 'element' && record.id === id
  ))
}

async function clickScene(
  _page: Page,
  scene: Locator,
  point: { x: number; y: number },
) {
  await scene.click({ position: point })
}

async function dragOnScene(
  page: Page,
  scene: Locator,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const bounds = await scene.boundingBox()
  if (!bounds) throw new Error('Whiteboard scene is not measurable')
  await page.mouse.move(bounds.x + start.x, bounds.y + start.y)
  await page.mouse.down()
  await page.mouse.move(bounds.x + end.x, bounds.y + end.y, { steps: 8 })
  await page.mouse.up()
}

async function dragBetweenElements(
  page: Page,
  fromId: string,
  toId: string,
) {
  const from = await page.locator(`[data-element-id="${fromId}"]`).boundingBox()
  const to = await page.locator(`[data-element-id="${toId}"]`).boundingBox()
  if (!from || !to) throw new Error('Connector targets are not measurable')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
  await page.mouse.up()
}

async function dragToElementPoint(
  page: Page,
  source: Locator,
  targetId: string,
  targetPoint: { x: number; y: number },
) {
  const from = await source.boundingBox()
  const to = await page.locator(`[data-element-id="${targetId}"]`).boundingBox()
  if (!from || !to) throw new Error('Drag targets are not measurable')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + targetPoint.x, to.y + targetPoint.y, { steps: 10 })
  await page.mouse.up()
}
