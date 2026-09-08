import os from 'node:os'
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

test('keeps a 520-layer artboard interactive while rendering 20 image layers', async ({
  page,
}, testInfo) => {
  await mockLocalWorkspaceApi(page)
  await page.goto('/documents')
  await dismissFirstRunActivation(page)
  await page
    .locator('.document-private-heading .document-create-menu-anchor > button')
    .click()
  await page.getByTestId('workspace-create-design').click()
  await expect(page.getByTestId('design-editor')).toBeVisible()
  await page
    .getByLabel('Import image', { exact: true })
    .setInputFiles('public/logo-mark.png')
  await expect(page.locator('.design-artwork image')).toHaveAttribute(
    'href',
    /^data:image/,
  )
  await expect(page.getByTestId('design-save-status')).toHaveText('Saved')
  await page.evaluate(async () => {
    const { createDesignNode } = await import(
      /* @vite-ignore */ ['/src/features/design/lib', 'designTypes.ts'].join(
        '/',
      )
    )
    const key = 'kition.workspace.documents.v1'
    const records = JSON.parse(localStorage.getItem(key)!)
    const doc = JSON.parse(records['Untitled design.kidesign'].content)
    const asset = Object.values(doc.assets)[0] as {
      id: string
      width: number
      height: number
    }
    doc.nodes = {}
    doc.pages[0].children = []
    for (let i = 0; i < 520; i++) {
      const node = createDesignNode(i < 500 ? 'rectangle' : 'image', {
        id: `layer-${i}`,
        width: 32,
        height: 36,
        transform: [
          1,
          0,
          0,
          1,
          20 + (i % 20) * 50,
          20 + Math.floor(i / 20) * 48,
        ],
        ...(i >= 500
          ? {
              assetId: asset.id,
              crop: { x: 0, y: 0, width: asset.width, height: asset.height },
            }
          : {}),
      })
      doc.nodes[node.id] = node
      doc.pages[0].children.push(node.id)
    }
    records['Untitled design.kidesign'].content = JSON.stringify(doc)
    localStorage.setItem(key, JSON.stringify(records))
  })
  await page.reload()
  await page.locator('.document-tab[data-tab-title="Untitled design"]').click()
  await expect(page.locator('.design-artwork [data-design-node]')).toHaveCount(
    520,
  )
  await expect(page.locator('.design-artwork image')).toHaveCount(20)
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  const target = page.locator('[data-design-node="layer-0"]')
  const box = (await target.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.evaluate(() => {
    const samples: number[] = []
    const stage = document.querySelector('.design-stage')!
    const listener = () => {
      const start = performance.now()
      requestAnimationFrame(() => samples.push(performance.now() - start))
    }
    stage.addEventListener('pointermove', listener, { capture: true })
    Object.assign(window, { designPerformanceSamples: samples })
  })
  await page.mouse.move(
    box.x + box.width / 2 + 180,
    box.y + box.height / 2 + 120,
    { steps: 40 },
  )
  await page.mouse.up()
  await expect(page.getByTestId('design-save-status')).toHaveText('Saved')
  const samples = await page.evaluate(
    () =>
      (window as unknown as { designPerformanceSamples: number[] })
        .designPerformanceSamples,
  )
  samples.sort((a, b) => a - b)
  const report = {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    browser: 'Chromium',
    nodes: 520,
    imageLayers: 20,
    samples: samples.length,
    medianInputToFrameMs: samples[Math.floor(samples.length / 2)],
    p95InputToFrameMs: samples[Math.floor(samples.length * 0.95)],
  }
  const reportPath = testInfo.outputPath('design-interaction.json')
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  await testInfo.attach('design-interaction.json', {
    path: reportPath,
    contentType: 'application/json',
  })
  expect(samples.length).toBeGreaterThanOrEqual(30)
  expect(report.p95InputToFrameMs).toBeLessThan(100)
  await page.screenshot({ path: testInfo.outputPath('design-520-layers.png') })
})
