import { expect, test } from '@playwright/test'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { DESIGN_STORAGE_KEY, expectDesignSaved } from './helpers/design'

test('inserts an exported design into the last active document', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await page.goto('/documents')
  await dismissFirstRunActivation(page)
  await page
    .locator('.document-private-heading .document-create-menu-anchor > button')
    .click()
  await page.locator('.document-create-option', { hasText: 'Document' }).first().click()
  const templates = page.getByRole('dialog', { name: 'Template Center' })
  await expect(templates).toBeVisible()
  // The blank document is the first card in the Template Center.
  await templates.getByRole('button', { name: 'Use', exact: true }).first().click()
  await expect(templates).toHaveCount(0)
  const documentTab = page.locator('.document-tab.is-active, .document-tab[aria-selected="true"]').first()
  await expect(documentTab).toBeVisible()
  const documentTitle = (await documentTab.getAttribute('data-tab-title'))!
  expect(documentTitle).toBeTruthy()

  await page
    .locator('.document-private-heading .document-create-menu-anchor > button')
    .click()
  await page.getByTestId('workspace-create-design').click()
  await expect(page.getByTestId('design-editor')).toBeVisible()
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await expectDesignSaved(page)

  await page.getByLabel('Export', { exact: true }).click()
  await page.getByRole('button', { name: 'Insert into document', exact: true }).click()
  await expect(page.getByText(`Inserted into ${documentTitle}`)).toBeVisible()
  await expect.poll(async () =>
    page.evaluate(
      ({ key, title }) => {
        const records = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, { content: string }>
        const entry = Object.entries(records).find(([path]) => path.startsWith(title) && path.endsWith('.md'))
        return entry?.[1].content ?? ''
      },
      { key: DESIGN_STORAGE_KEY, title: documentTitle },
    ),
  ).toContain('![Untitled design](<attachments/design/')
})
