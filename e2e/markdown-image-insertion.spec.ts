import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, expect, test, type Page, type Route } from '@playwright/test'
import electronPath from 'electron'

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

function fulfillNdjson(route: Route, events: unknown[]) {
  return route.fulfill({
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
    },
    body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  })
}

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

test('Agent image generation forwards a safe fenced-code cursor anchor and renders the mocked revision', async ({ baseURL }) => {
  test.setTimeout(90_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-image-insertion-'))
  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      KITION_ELECTRON_DEV_SERVER_URL: baseURL as string,
      KITION_DESKTOP_SKIP_API: 'true',
    },
  })

  try {
    const page = await app.firstWindow()
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
    const now = '2026-08-27T12:00:00.000Z'
    let requestBody: Record<string, any> | null = null

    await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
      requestBody = route.request().postDataJSON() as Record<string, any>
      const streamSessionId = Number(
        new URL(route.request().url()).pathname.match(/sessions\/(\d+)\/messages/)?.[1] || 901,
      )

      // The private runtime is outside this repository. Mock its final document
      // write here so this E2E can exercise the public client request, revision,
      // acceptance, and rendering chain. Resolver unit tests own placement policy.
      await page.evaluate(async ({ documentPath, markdown }) => {
        const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
        if (!bridge?.WriteWorkspaceDocument) {
          throw new Error('workspace document writer is unavailable')
        }
        await bridge.WriteWorkspaceDocument({ path: documentPath, content: markdown })
      }, { documentPath: fixture.documentPath, markdown: updatedMarkdown })

      await fulfillNdjson(route, [
        {
          type: 'user_message',
          chat_message: {
            id: 9801,
            session_id: streamSessionId,
            user_id: 1,
            role: 'user',
            content: 'Generate a pendant image and insert it into this document',
            status: 'completed',
            created_at: now,
          },
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 9802,
            session_id: streamSessionId,
            message_id: 9801,
            user_id: 1,
            tool_name: 'image_generation',
            input_data: { prompt: 'A silver pendant' },
            output_data: {
              path: fixture.assetPath,
              mime_type: 'image/png',
            },
            status: 'completed',
            created_at: now,
            updated_at: now,
          },
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 9803,
            session_id: streamSessionId,
            message_id: 9801,
            user_id: 1,
            tool_name: 'apply_patch',
            input_data: { path: fixture.documentPath },
            output_data: {
              file_ops: [{ kind: 'update', path: fixture.documentPath }],
            },
            status: 'completed',
            created_at: now,
            updated_at: now,
          },
        },
        {
          type: 'done',
          done: true,
          extra_data: {
            message: {
              id: 9804,
              session_id: streamSessionId,
              user_id: 1,
              role: 'assistant',
              content: 'Generated the pendant image and inserted it after the fenced code block.',
              status: 'completed',
              created_at: now,
            },
            session: {
              id: streamSessionId,
              user_id: 1,
              title: 'Chat',
              workspace_root: 'browser-local-workspace',
              active_document_path: fixture.documentPath,
              status: 'completed',
              created_at: now,
              updated_at: now,
            },
          },
        },
      ])
    })

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
    expect(requestBody).not.toBeNull()
    expect(requestBody).toMatchObject({
      active_document_path: fixture.documentPath,
      active_data_document_id: 0,
      active_data_table_id: 0,
    })
    const promptContext = String(requestBody?.prompt_context || '')
    expect(promptContext).toContain('Preferred safe image insertion: line 6')
    expect(promptContext).toContain('strategy: nearest-blank-line')
    expect(promptContext).toContain('Never insert a Markdown image inside fenced or inline code')
    expect(promptContext).toContain('If no top-level blank line is available')

    const revisionReview = page.locator('.document-revision-review')
    await expect(revisionReview).toBeVisible()
    await expect(revisionReview).toContainText(`![Generated pendant](${fixture.assetPath})`)
    await revisionReview.getByRole('button', { name: 'Accept all' }).click()
    await expect(revisionReview).toBeHidden()

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
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
