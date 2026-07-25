import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, expect, test, type Page, type Route } from '@playwright/test'
import electronPath from 'electron'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

type MockBrowserBridgeOptions = {
  entities: Array<Record<string, unknown>>
  pageUrl?: string
  pageTitle?: string
  host?: string
  heading?: string
  contentPreview?: string
  visiblePreview?: string
  mainContentHtml?: string
  htmlSnapshot?: string
  contentBlocks?: Array<Record<string, unknown>>
}

function fulfillNdjson(route: Route, events: unknown[]) {
  return route.fulfill({
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
    },
    body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  })
}

async function installMockBrowserBridge(page: Page, options: MockBrowserBridgeOptions) {
  return page.evaluate((input) => {
    const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop as Record<string, any>
    if (!bridge) {
      throw new Error('desktop bridge is unavailable')
    }
    if (typeof bridge.SetTestBrowserSessionMock !== 'function') {
      throw new Error('desktop test browser session mock bridge is unavailable')
    }

    return bridge.SetTestBrowserSessionMock({
      status: {
        provider: 'generic-web',
        supported: true,
        available: true,
        window_open: true,
        logged_in: true,
        editor_ready: false,
        page_url: input.pageUrl,
        page_title: input.pageTitle,
        message: 'ready',
        last_error: '',
        panel_visible: true,
        panel_width: 420,
        runtime: {
          navigation: {
            stage: 'loaded',
          },
        },
      },
      pageContext: {
        provider: 'generic-web',
        supported_page: true,
        logged_in: true,
        editor_ready: false,
        page_url: input.pageUrl,
        page_title: input.pageTitle,
        hostname: input.host,
        page_heading: input.heading,
        page_type: 'list',
        content_text_preview: input.contentPreview,
        visible_text_preview: input.visiblePreview,
        main_content_html: input.mainContentHtml,
        html_snapshot: input.htmlSnapshot,
        content_blocks: input.contentBlocks,
        extracted_at: '2026-05-20T12:00:00.000Z',
        extracted_entities: input.entities,
      },
    })
  }, {
    entities: options.entities,
    pageUrl: options.pageUrl ?? 'https://www.youtube.com/',
    pageTitle: options.pageTitle ?? 'youtube',
    host: options.host ?? 'youtube.com',
    heading: options.heading ?? 'Recommended videos',
    contentPreview: options.contentPreview ?? 'YouTube home feed with multiple recommended videos.',
    visiblePreview: options.visiblePreview ?? 'YouTube page ready for summary.',
    mainContentHtml: options.mainContentHtml ?? '<main><article><h2>Video A</h2><p>Visible summary A</p></article><article><h2>Video B</h2><p>Visible summary B</p></article></main>',
    htmlSnapshot: options.htmlSnapshot ?? '<html><body><main><section data-card="video"><a href="/video/BV1A001">Video A</a></section><section data-card="video"><a href="/video/BV1A002">Video B</a></section></main></body></html>',
    contentBlocks: options.contentBlocks ?? [
      {
        url: 'https://www.youtube.com/watch?v=video001',
        title: 'Video A',
        summary: 'Visible summary A',
        text: 'Video A Visible summary A',
        html: '<article><h2>Video A</h2><p>Visible summary A</p></article>',
      },
      {
        url: 'https://www.youtube.com/watch?v=video002',
        title: 'Video B',
        summary: 'Visible summary B',
        text: 'Video B Visible summary B',
        html: '<article><h2>Video B</h2><p>Visible summary B</p></article>',
      },
    ],
  })
}

test('workspace chat can auto-open saved docs and target @{mentions} without a bound table', async ({ baseURL }) => {
  test.setTimeout(90_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-doc-agent-'))
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
            deepseek: {
              kind: 'deepseek',
              enabled: false,
              label: 'DeepSeek',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKey: '',
              accessToken: '',
              refreshToken: '',
              modelsPath: '/models',
              authHeader: '',
              authScheme: 'bearer',
              wireApi: 'chat_completions',
              reasoningEffort: 'medium',
              disableResponseStorage: true,
              discoveredModels: [],
              lastSyncedAt: '',
            },
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
              lastSyncedAt: '2026-05-20T12:00:00.000Z',
            },
            custom: {
              kind: 'custom',
              enabled: false,
              label: 'Custom Provider',
              baseUrl: '',
              apiKey: '',
              accessToken: '',
              refreshToken: '',
              modelsPath: '/models',
              authHeader: 'Authorization',
              authScheme: 'bearer',
              wireApi: 'responses',
              reasoningEffort: 'medium',
              disableResponseStorage: true,
              discoveredModels: [],
              lastSyncedAt: '',
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

    const createdDocs = await page.evaluate(async () => {
      const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
      if (!bridge?.CreateWorkspaceDocument || !bridge?.WriteWorkspaceDocument) {
        throw new Error('workspace document bridge is unavailable')
      }

      const mentionDoc = await bridge.CreateWorkspaceDocument({
        title: 'Plan',
        folder: 'Docs',
        platform: 'Research',
        format: 'markdown',
      })
      await bridge.WriteWorkspaceDocument({
        path: mentionDoc.path,
        content: '# Plan\n\nMention target content for the agent.',
      })

      const artifactDoc = await bridge.CreateWorkspaceDocument({
        title: 'Agent Notes',
        folder: '',
        platform: 'Research',
        format: 'markdown',
      })
      await bridge.WriteWorkspaceDocument({
        path: artifactDoc.path,
        content: '# Agent Notes\n\nExisting placeholder file for artifact refresh.',
      })

      return {
        mentionPath: mentionDoc.path,
        artifactPath: artifactDoc.path,
      }
    }) as { mentionPath: string; artifactPath: string }
    const artifactTitle = createdDocs.artifactPath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') || 'Agent Notes'
    const mentionTitle = createdDocs.mentionPath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') || 'Plan'

    const now = '2026-05-20T12:00:00.000Z'
    const requestBodies: Array<Record<string, any>> = []
    let streamRequestCount = 0

    await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
      streamRequestCount += 1
      const payload = route.request().postDataJSON() as Record<string, any>
      requestBodies.push(payload)

      // Echo the session id the frontend addressed (real backend keeps the same
      // session); hardcoding a different id would make the panel switch sessions
      // and reload empty history after the first turn.
      const streamSessionId = Number(
        new URL(route.request().url()).pathname.match(/sessions\/(\d+)\/messages/)?.[1] || 901,
      )

      if (streamRequestCount === 1) {
        await fulfillNdjson(route, [
          {
            type: 'user_message',
            chat_message: {
              id: 9901,
              session_id: 901,
              user_id: 1,
              role: 'user',
              content: 'Write a short launch brief',
              status: 'completed',
              created_at: now,
            },
          },
          {
            type: 'done',
            done: true,
            extra_data: {
              artifact: {
                id: 9902,
                session_id: 901,
                user_id: 1,
                kind: 'markdown',
                path: createdDocs.artifactPath,
                mime_type: 'text/markdown',
                title: 'Agent Notes',
                created_at: now,
              },
              message: {
                id: 9903,
                session_id: 901,
                user_id: 1,
                role: 'assistant',
                content: 'Saved a launch brief into Agent Notes.',
                status: 'completed',
                created_at: now,
              },
              session: {
                id: streamSessionId,
                user_id: 1,
                title: 'Chat',
                workspace_root: 'browser-local-workspace',
                active_document_path: '',
                status: 'completed',
                created_at: now,
                updated_at: now,
              },
            },
          },
        ])
        return
      }

      await fulfillNdjson(route, [
        {
          type: 'user_message',
          chat_message: {
            id: 9911,
            session_id: 901,
            user_id: 1,
            role: 'user',
            content: `Use @{${createdDocs.mentionPath}} and summarize it`,
            status: 'completed',
            created_at: now,
          },
        },
        {
          type: 'done',
          done: true,
          extra_data: {
            message: {
              id: 9912,
              session_id: 901,
              user_id: 1,
              role: 'assistant',
              content: `Summarized the referenced \`${createdDocs.mentionPath}\` document.`,
              status: 'completed',
              created_at: now,
            },
            session: {
              id: streamSessionId,
              user_id: 1,
              title: 'Chat',
              workspace_root: 'browser-local-workspace',
              active_document_path: createdDocs.artifactPath,
              status: 'completed',
              created_at: now,
              updated_at: now,
            },
          },
        },
      ])
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('document-tree')).toBeVisible()

    await page.locator('.workspace-agent-topbar-reopen').click()
    await page.locator('button[aria-label="New chat"]').click()
    await expect(page.locator('.agent-chat-panel')).toBeVisible()

    const composer = page.locator('.agent-ai-composer textarea')
    const sendButton = page.locator('.agent-ai-send')
    const userMessages = page.locator('.agent-message.is-user')
    const assistantMessages = page.locator('.agent-message.is-assistant')

    await composer.fill('Write a short launch brief')
    await sendButton.click()

    await expect(userMessages).toHaveCount(1)
    await expect(userMessages.nth(0)).toContainText('Write a short launch brief')
    await expect(assistantMessages.nth(0)).toContainText('Saved a launch brief into Agent Notes.')
    await expect(
      page
        .locator('[data-testid="document-tree"] .document-tree-row')
        .filter({ hasText: artifactTitle })
        .last(),
    ).toBeVisible()
    // Converged thin-transport behavior: the saved artifact renders as a
    // click-to-open card in the chat; it no longer auto-opens in the editor.
    await expect(page.locator('.agent-artifact').filter({ hasText: artifactTitle })).toBeVisible()

    expect(requestBodies[0]).toMatchObject({
      active_document_path: '',
      active_data_document_id: 0,
      active_data_table_id: 0,
      save_markdown: true,
    })

    await composer.fill(`Use @{${createdDocs.mentionPath}} and summarize it`)
    await sendButton.click()

    await expect(userMessages).toHaveCount(2)
    await expect(
      userMessages.nth(1).getByRole('button', {
        name: `@${createdDocs.mentionPath}`,
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      assistantMessages.nth(1).getByRole('button', {
        name: createdDocs.mentionPath,
        exact: true,
      }),
    ).toBeVisible()
    await userMessages.nth(1).getByRole('button', {
      name: `@${createdDocs.mentionPath}`,
      exact: true,
    }).click()
    await expect(
      page.locator('.document-tab.is-active').filter({ hasText: mentionTitle }),
    ).toBeVisible()
    await assistantMessages.nth(1).getByRole('button', {
      name: createdDocs.mentionPath,
      exact: true,
    }).click()
    await expect(
      page.locator('.document-tab.is-active').filter({ hasText: mentionTitle }),
    ).toBeVisible()

    expect(requestBodies[1]).toMatchObject({
      active_document_path: createdDocs.mentionPath,
      active_data_document_id: 0,
      active_data_table_id: 0,
      save_markdown: false,
    })
    expect(String(requestBodies[1].prompt_context || '')).toContain(createdDocs.mentionPath)
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})

test.skip('workspace chat can continue from the current browser page and save a markdown artifact without a bound table', async ({ baseURL }) => {
  test.setTimeout(90_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-browser-doc-agent-'))
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
            deepseek: {
              kind: 'deepseek',
              enabled: false,
              label: 'DeepSeek',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKey: '',
              accessToken: '',
              refreshToken: '',
              modelsPath: '/models',
              authHeader: '',
              authScheme: 'bearer',
              wireApi: 'chat_completions',
              reasoningEffort: 'medium',
              disableResponseStorage: true,
              discoveredModels: [],
              lastSyncedAt: '',
            },
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
              lastSyncedAt: '2026-05-20T12:00:00.000Z',
            },
            custom: {
              kind: 'custom',
              enabled: false,
              label: 'Custom Provider',
              baseUrl: '',
              apiKey: '',
              accessToken: '',
              refreshToken: '',
              modelsPath: '/models',
              authHeader: 'Authorization',
              authScheme: 'bearer',
              wireApi: 'responses',
              reasoningEffort: 'medium',
              disableResponseStorage: true,
              discoveredModels: [],
              lastSyncedAt: '',
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

    const createdDocs = await page.evaluate(async () => {
      const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
      if (!bridge?.CreateWorkspaceDocument || !bridge?.WriteWorkspaceDocument) {
        throw new Error('workspace document bridge is unavailable')
      }

      const artifactDoc = await bridge.CreateWorkspaceDocument({
        title: 'YouTube Brief',
        folder: '',
        platform: 'Research',
        format: 'markdown',
      })
      await bridge.WriteWorkspaceDocument({
        path: artifactDoc.path,
        content: '# YouTube Brief\n\nPlaceholder content.',
      })

      return {
        artifactPath: artifactDoc.path,
      }
    }) as { artifactPath: string }

    const artifactTitle = createdDocs.artifactPath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') || 'YouTube Brief'

    const browserEntities = [
      {
        entity_type: 'video',
        url: 'https://www.youtube.com/watch?v=video001',
        title: 'Video A',
        author: 'UP A',
        summary: 'Visible summary A',
      },
      {
        entity_type: 'video',
        url: 'https://www.youtube.com/watch?v=video002',
        title: 'Video B',
        author: 'UP B',
        summary: 'Visible summary B',
      },
    ]

    const now = '2026-05-20T12:00:00.000Z'
    const requestBodies: Array<Record<string, any>> = []
    let streamRequestCount = 0

    await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
      streamRequestCount += 1
      const payload = route.request().postDataJSON() as Record<string, any>
      requestBodies.push(payload)

      // Echo the session id the frontend addressed (real backend keeps the same
      // session); hardcoding a different id would make the panel switch sessions
      // and reload empty history after the first turn.
      const streamSessionId = Number(
        new URL(route.request().url()).pathname.match(/sessions\/(\d+)\/messages/)?.[1] || 902,
      )

      if (streamRequestCount === 1) {
        await fulfillNdjson(route, [
          {
            type: 'user_message',
            chat_message: {
              id: 9951,
              session_id: 902,
              user_id: 1,
              role: 'user',
              content: 'Open youtube.com',
              status: 'completed',
              created_at: now,
            },
          },
          {
            type: 'agent_event',
            event: {
              id: 9952,
              session_id: 902,
              user_id: 1,
              event_type: 'browser.open_required',
              stage: 'browser',
              status: 'completed',
              label: 'Open browser tab',
              message: 'Open youtube.com in the browser tab.',
	              data: {
	                action: 'open_embedded_browser',
	                provider: 'generic-web',
	                adapter: 'youtube',
	                command: 'feed',
	                entity_type: 'video',
	                host: 'youtube.com',
	                url: 'https://www.youtube.com/',
	                task_hint: 'open_site',
	                followup_mode: 'wait',
	              },
              created_at: now,
            },
          },
          {
            type: 'done',
            extra_data: {
              session: {
                id: streamSessionId,
                user_id: 1,
                title: 'Open youtube.com',
                active_document_path: '',
                created_at: now,
                updated_at: now,
              },
              message: {
                id: 9953,
                session_id: 902,
                user_id: 1,
                role: 'assistant',
                content: 'Opened youtube.com in the browser tab and kept this chat active.',
                status: 'completed',
                created_at: now,
              },
            },
          },
        ])
        return
      }

      await fulfillNdjson(route, [
        {
          type: 'user_message',
          chat_message: {
            id: 9961,
            session_id: 902,
            user_id: 1,
            role: 'user',
            content: String(payload.content || ''),
            status: 'completed',
            created_at: now,
          },
        },
        {
          type: 'done',
          done: true,
          extra_data: {
            artifact: {
              id: 9962,
              session_id: 902,
              user_id: 1,
              kind: 'markdown',
              path: createdDocs.artifactPath,
              mime_type: 'text/markdown',
              title: artifactTitle,
              created_at: now,
            },
            message: {
              id: 9963,
              session_id: 902,
              user_id: 1,
              role: 'assistant',
              content: 'Saved a youtube page brief into YouTube Brief.',
              status: 'completed',
              created_at: now,
            },
            session: {
              id: streamSessionId,
              user_id: 1,
              title: 'Chat',
              workspace_root: 'browser-local-workspace',
              active_document_path: '',
              status: 'completed',
              created_at: now,
              updated_at: now,
            },
          },
        },
      ])
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('document-tree')).toBeVisible()
    const patchedBridge = await installMockBrowserBridge(page, {
      entities: browserEntities,
    })
    expect(patchedBridge).toEqual({ enabled: true })

    await page.locator('.workspace-agent-topbar-reopen').click()
    await page.locator('button[aria-label="New chat"]').click()
    await expect(page.locator('.agent-chat-panel')).toBeVisible()

    const composer = page.locator('.agent-ai-composer textarea')
    const sendButton = page.locator('.agent-ai-send')
    const userMessages = page.locator('.agent-message.is-user')
    const assistantMessages = page.locator('.agent-message.is-assistant')

    await composer.fill('Open youtube.com')
    await sendButton.click()

    await expect(userMessages).toHaveCount(1)
    await expect(userMessages.nth(0)).toContainText('Open youtube.com')
    await expect(assistantMessages.nth(0)).toContainText('Opened youtube.com in the browser tab and kept this chat active.')

    // The browser handoff auto-opens the page; no explicit user click is required.
    await expect(page.locator('.document-tab.is-browser').filter({ hasText: 'youtube.com' })).toBeVisible()

    await composer.fill('Summarize the current page into a document')
    await sendButton.click()

    await expect(userMessages).toHaveCount(2)
    await expect(userMessages.nth(1)).toContainText('Summarize the current page into a document')
    await expect(assistantMessages.nth(1)).toContainText('Saved a youtube page brief into YouTube Brief.')
    await expect(page.locator('.agent-artifact').filter({ hasText: artifactTitle })).toBeVisible()

    expect(requestBodies[0]).toMatchObject({
      active_document_path: '',
      active_data_document_id: 0,
      active_data_table_id: 0,
      save_markdown: true,
      task_mode: 'auto',
    })

    expect(requestBodies[1]).toMatchObject({
      active_document_path: '',
      active_data_document_id: 0,
      active_data_table_id: 0,
      save_markdown: true,
      task_mode: 'auto',
      browser_context: {
        host: 'youtube.com',
        page_url: 'https://www.youtube.com/',
        main_content_html: '<main><article><h2>Video A</h2><p>Visible summary A</p></article><article><h2>Video B</h2><p>Visible summary B</p></article></main>',
        html_snapshot: '<html><body><main><section data-card="video"><a href="/video/BV1A001">Video A</a></section><section data-card="video"><a href="/video/BV1A002">Video B</a></section></main></body></html>',
      },
    })
    expect(Array.isArray(requestBodies[1].browser_context?.content_blocks)).toBe(true)
    expect(requestBodies[1].browser_context.content_blocks).toHaveLength(2)
    expect(Array.isArray(requestBodies[1].browser_context?.extracted_entities)).toBe(true)
    expect(String(requestBodies[1].content || '')).toBe('Summarize the current page into a document')
    // The converged frontend is a thin transport layer: it no longer injects task-mode
    // instruction strings into prompt_context (that decision moved to the backend skills).
    expect(String(requestBodies[1].prompt_context || '')).not.toContain('write the results into the active table now')
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
