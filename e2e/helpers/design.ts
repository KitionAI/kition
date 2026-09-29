import { expect, type Page } from '@playwright/test'
import type { DesignDocument } from '../../src/features/design/lib/designTypes'
import { mockLocalWorkspaceApi } from './mockApi'
import { dismissFirstRunActivation } from './onboarding'

export const DESIGN_STORAGE_KEY = 'kition.workspace.documents.v1'

/** Opens the documents page and creates a new untitled design. */
export async function createDesign(page: Page) {
  await mockLocalWorkspaceApi(page)
  await page.goto('/documents')
  await dismissFirstRunActivation(page)
  await page
    .locator('.document-private-heading .document-create-menu-anchor > button')
    .click()
  await page.getByTestId('workspace-create-design').click()
  await expect(page.getByTestId('design-editor')).toBeVisible()
}

/** Reads the saved untitled design back from the mocked workspace storage. */
export async function readDesign(page: Page): Promise<DesignDocument> {
  return page.evaluate((key) => {
    const records = JSON.parse(localStorage.getItem(key) || '{}')
    return JSON.parse(records['Untitled design.kidesign'].content)
  }, DESIGN_STORAGE_KEY)
}

export async function fillDesignNumber(page: Page, label: string, value: number) {
  const field = page.getByRole('spinbutton', { name: label, exact: true })
  await field.fill(String(value))
  await field.press('Enter')
}

export async function expectDesignSaved(page: Page) {
  await expect(page.getByTestId('design-save-status')).toHaveText('Saved')
}

export function designLayers(doc: DesignDocument) {
  return doc.pages[0].children.map((id) => doc.nodes[id])
}
