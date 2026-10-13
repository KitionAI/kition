import { expect, test, type Page } from '@playwright/test'

import { mockAgentTurn } from './helpers/agentStream'
import { installDesktopHost } from './helpers/desktopHost'
import { mockDocumentBridge } from './helpers/documentBridge'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

const initialMarkdown = [
  '# Pendant',
  '',
  '```ts',
  'const pendant = "silver"',
  '```',
  '',
  'Existing paragraph after the fenced code block.',
].join('\n')

const transparentPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

async function configureMockAgent(page: Page) {
  await page.evaluate(async () => {
    const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
    if (!bridge?.StoreSecureValue) {
      throw new Error('secure store is unavailable')
    }
    await bridge.StoreSecureValue(
      'kition.desktop.settings.v1',
      JSON.stringify({
        general: {
          theme: 'light',
          language: 'en-US',
          restoreWorkspaceOnLaunch: true,
          confirmBeforeQuit: true,
          autoCheckUpdates: true,
        },
        shortcuts: [],
        providers: {
          openai: {
            kind: 'openai',
            enabled: true,
            label: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test-key',
            accessToken: '',
            refreshToken: '',
            modelsPath: '/models',
            authHeader: '',
            authScheme: 'bearer',
            wireApi: 'responses',
            reasoningEffort: 'medium',
            disableResponseStorage: true,
            discoveredModels: ['gpt-test'],
            lastSyncedAt: '2026-08-27T12:00:00.000Z',
          },
        },
        models: {
          activeProvider: 'openai',
          selectedModelByProvider: {
            openai: 'gpt-test',
          },
          preferredDefaultModel: 'gpt-test',
          preferredChatModel: 'gpt-test',
          preferredWritingModel: 'gpt-test',
        },
      }),
    )
  })
}

test('Agent image generation forwards a safe fenced-code cursor anchor and renders the mocked live edit', async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  expect(baseURL).toBeTruthy()

  const host = await installDesktopHost(page)

  try {
    await mockLocalWorkspaceApi(page)

    await page.goto(new URL('/documents', baseURL as string).toString(), {
      waitUntil: 'domcontentloaded',
    })
    await dismissFirstRunActivation(page)
    await expect(page.getByTestId('document-tree')).toBeVisible()

    await page.evaluate(() => {
      window.localStorage.removeItem('kition.document.tree.metadata.v1')
      window.localStorage.removeItem('kition.document.sidebar.width.v1')
      window.localStorage.removeItem('kition.document.recent.workspaces.v1')
      window.localStorage.removeItem('kition.document.last-active-path.v1')
      window.localStorage.removeItem('kition.document.workspace-tabs.v1')
      window.localStorage.removeItem('kition.table-agent.safe-mode.v1')
    })
    await configureMockAgent(page)

    const fixture = await page.evaluate(async ({ markdown, pngBase64 }) => {
      const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
      if (!bridge?.CreateWorkspaceDocument || !bridge?.WriteWorkspaceDocument || !bridge?.SaveWorkspaceAsset) {
        throw new Error('workspace document bridge is unavailable')
      }
      const document = await bridge.CreateWorkspaceDocument({
        title: 'Image Placement Regression',
        folder: '',
        platform: 'Research',
        format: 'markdown',
      })
      await bridge.WriteWorkspaceDocument({
        path: document.path,
        content: markdown,
      })
      const asset = await bridge.SaveWorkspaceAsset({
        document_path: document.path,
        filename: 'generated-pendant.png',
        mime_type: 'image/png',
        base64_content: pngBase64,
      })
      return {
        documentPath: document.path as string,
        assetPath: asset.path as string,
      }
    }, { markdown: initialMarkdown, pngBase64: transparentPngBase64 })

    const updatedMarkdown = [
      '# Pendant',
      '',
      '```ts',
      'const pendant = "silver"',
      '```',
      '',
      `![Generated pendant](${fixture.assetPath})`,
      '',
      'Existing paragraph after the fenced code block.',
    ].join('\n')
    const documentBridge = await mockDocumentBridge(page)
    const turns = await mockAgentTurn(page, async (turn) => {
      // The runtime is outside this test. Mock its final edit of the open document here
      // (`document/apply` over the document bridge, as the runtime sends it) so this E2E
      // can exercise the public client request, live edit, acceptance, and rendering
      // chain. Resolver unit tests own placement policy.
      const answer = await documentBridge.request('document/apply', { path: fixture.documentPath, content: updatedMarkdown, tool: 'apply_patch' })
      expect(answer.result).toMatchObject({ applied: true })
      turn.tool('ig_1', 'image_generation', { hosted: true }, { path: fixture.assetPath, mime: 'image/png' })
      turn.deliver('ig_1', fixture.assetPath)
      turn.tool('call_patch', 'apply_patch', { path: fixture.documentPath }, {
        file_ops: [{ kind: 'update', path: fixture.documentPath }],
      })
      turn.nextStep()
      turn.reply('Generated the pendant image and inserted it after the fenced code block.')
    })
    const requestBody = () => turns.requests[0]?.body as Record<string, any> | undefined

    await page.evaluate((documentPath) => {
      window.localStorage.setItem('kition.document.last-active-path.v1', documentPath)
    }, fixture.documentPath)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('document-tree')).toBeVisible()
    await expect(page.getByTestId('document-editor')).toBeVisible()

    await page.locator('.document-title-row-menu-trigger').click()
    await page.getByRole('button', { name: 'Source view' }).click()
    const codeLine = page.locator('.document-markdown-source .cm-line').filter({ hasText: 'const pendant' })
    await expect(codeLine).toBeVisible()
    await codeLine.click()

    await page.getByTestId('agent-floating-launcher').click()
    await page.locator('button[aria-label="New chat"]').click()
    const composer = page.locator('.agent-ai-composer textarea')
    await composer.fill('Generate a pendant image and insert it into this document')
    await page.locator('.agent-ai-send').click()

    await expect(page.locator('.agent-message.is-assistant')).toContainText(
      'Generated the pendant image and inserted it after the fenced code block.',
    )
    expect(requestBody()).toBeDefined()
    expect(requestBody()).toMatchObject({
      active_document_path: fixture.documentPath,
      active_data_document_id: 0,
      active_data_table_id: 0,
    })
    const promptContext = String(requestBody()?.prompt_context || '')
    expect(promptContext).toContain('Preferred safe image insertion: line 6')
    expect(promptContext).toContain('strategy: nearest-blank-line')
    expect(promptContext).toContain('Never insert a Markdown image inside fenced or inline code')
    expect(promptContext).toContain('If no top-level blank line is available')

    const agentReview = page.getByTestId('document-agent-review')
    await expect(agentReview).toBeVisible()
    await expect(page.locator('.document-markdown-source .cm-agent-review-added').first()).toContainText(`![Generated pendant](${fixture.assetPath})`)
    await agentReview.getByRole('button', { name: 'Accept all' }).click()
    await expect(agentReview).toBeHidden()

    const storedMarkdown = await page.evaluate(async (documentPath) => {
      const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
      return (await bridge?.ReadWorkspaceDocument?.({ path: documentPath }))?.content as string
    }, fixture.documentPath)
    expect(storedMarkdown).toBe(updatedMarkdown)
    expect(storedMarkdown).toContain('```\n\n![Generated pendant]')
    expect(storedMarkdown).not.toContain('const pendant = "silver"\n![Generated pendant]')

    await page.locator('.document-title-row-menu-trigger').click()
    await page.getByRole('button', { name: 'Edit view' }).click()
    await expect(page.locator('.document-editor img[alt="Generated pendant"]')).toBeVisible()
  } finally {
    await host.dispose()
  }
})
