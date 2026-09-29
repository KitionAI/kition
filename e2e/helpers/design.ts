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

/**
 * Advertises runtime capabilities through the desktop status bridge and
 * configures a model so the agent composer is enabled.
 */
export async function installDesignAgentFixture(page: Page, capabilities: string[]) {
  await page.addInitScript((flags: string[]) => {
    const host = window as unknown as { kitionDesktop?: Record<string, unknown> }
    host.kitionDesktop = {
      ...(host.kitionDesktop || {}),
      BackendStatus: async () => ({
        base_url: 'http://127.0.0.1:18101/api',
        health_url: 'http://127.0.0.1:18101/health',
        running: true,
        last_error: '',
        logs: '',
        log_file: '',
        launch_mode: 'managed',
        binary_path: '',
        config_path: '',
        working_dir: '',
        command: '',
        capabilities: flags,
      }),
    }
    window.localStorage.setItem(
      'kition.desktop.settings.backup.v1',
      JSON.stringify({
        providers: {
          openai: {
            enabled: true,
            label: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test-key',
            wireApi: 'responses',
            discoveredModels: ['gpt-test'],
          },
        },
        models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-test' } },
      }),
    )
  }, capabilities)
}

export function designLayers(doc: DesignDocument) {
  return doc.pages[0].children.map((id) => doc.nodes[id])
}
