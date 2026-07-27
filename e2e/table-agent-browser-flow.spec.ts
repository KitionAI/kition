import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, expect, test, type Page, type Route } from '@playwright/test'
import electronPath from 'electron'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function fulfillNdjson(route: Route, events: unknown[]) {
  const pathname = new URL(route.request().url()).pathname
  const sessionMatch = pathname.match(/\/agent\/sessions\/(\d+)\/messages\/stream$/)
  if (!sessionMatch) {
    throw new Error(`missing stream session id in ${pathname}`)
  }
  const sessionId = Number(sessionMatch[1])

  const bindSessionId = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(bindSessionId)
    }
    if (!value || typeof value !== 'object') {
      return value
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (key === 'session_id') {
          return [key, sessionId]
        }
        if (key === 'session' && item && typeof item === 'object' && !Array.isArray(item)) {
          return [
            key,
            {
              ...(bindSessionId(item) as Record<string, unknown>),
              id: sessionId,
            },
          ]
        }
        return [key, bindSessionId(item)]
      }),
    )
  }

  const boundEvents = bindSessionId(events) as unknown[]
  return route.fulfill({
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
    },
    body: `${boundEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
  })
}

type MockBrowserBridgeOptions = {
  entities: Array<Record<string, unknown>>
  pageUrl?: string
  pageTitle?: string
  host?: string
  heading?: string
  contentPreview?: string
  visiblePreview?: string
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
        extracted_at: '2026-05-20T12:00:00.000Z',
        extracted_entities: input.entities,
      },
    })
  }, {
    entities: options.entities,
    pageUrl: options.pageUrl ?? 'https://www.youtube.com/',
    pageTitle: options.pageTitle ?? 'YouTube',
    host: options.host ?? 'youtube.com',
    heading: options.heading ?? 'Videos',
    contentPreview: options.contentPreview ?? 'YouTube feed with multiple recommended videos.',
    visiblePreview: options.visiblePreview ?? 'List page ready for sync.',
  })
}

async function openUnifiedAgentChat(page: Page) {
  const openButton = page.getByRole('button', { name: 'Open AI Chat' })
  if (await openButton.isVisible()) {
    await openButton.click()
  }
  const sidebar = page.locator('.workspace-agent-sidebar')
  await expect(sidebar).toBeVisible()
  const tabs = page.getByRole('tab')
  const selectedTab = page.getByRole('tab', { selected: true })
  if ((await tabs.count()) === 0 || !(await selectedTab.isVisible().catch(() => false))) {
    const previousTabCount = await tabs.count()
    await page.getByRole('button', { name: 'New chat' }).click()
    await expect(tabs).toHaveCount(previousTabCount + 1)
  }
  await expect(page.getByRole('tab', { name: 'New chat', selected: true })).toBeVisible()
  return {
    sidebar,
    composer: sidebar.getByPlaceholder('Plan, write, or ask anything…'),
    sendButton: sidebar.getByRole('button', { name: 'Send' }),
  }
}

test('table agent opens youtube.com and automatically resumes a combined capture task', async ({ baseURL }) => {
  test.setTimeout(90_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-table-agent-'))
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
      waitUntil: 'commit',
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

    const tableTitle = `YouTube Sync ${Date.now().toString().slice(-6)}`

    const createdDocument = await page.evaluate(async (nextTitle) => {
      const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
      if (!bridge?.CreateWorkspaceDocument) {
        throw new Error('create workspace document is unavailable')
      }
      return bridge.CreateWorkspaceDocument({
        title: nextTitle,
        folder: '',
        platform: 'Research',
        format: 'data',
      })
    }, tableTitle) as {
      path: string
      name: string
    }

    const documentPath = String(createdDocument.path || '').trim()
    const now = '2026-05-20T12:00:00.000Z'
    const capturePrompt = [
      'Open youtube.com in the built-in browser, collect every video card currently loaded on the homepage, and write the results into a new structured table file.',
      'Include Title, Video URL, Channel or Author, Views, Duration, Published At, Thumbnail or Cover, Source Page, Captured At, and Summary or Notes.',
      'Use Video URL as the unique key. Continue automatically after the browser opens, and do not mark the task complete until the rows are saved.',
      'If browser access or extraction is unavailable, report the blocker instead of creating an empty completed table.',
    ].join(' ')
    const browserEntities = [
      {
        entity_type: 'video',
        url: 'https://www.youtube.com/watch?v=video001',
        title: 'YouTube video brief 1',
        author: 'Creator Alpha',
        summary: 'Weekly technology news and product launch highlights.',
      },
      {
        entity_type: 'video',
        url: 'https://www.youtube.com/watch?v=video002',
        title: 'YouTube video brief 2',
        author: 'Creator Beta',
        summary: 'A practical guide to editing short-form videos.',
      },
      {
        entity_type: 'video',
        url: 'https://www.youtube.com/watch?v=video003',
        title: 'YouTube video brief 3',
        author: 'Creator Gamma',
        summary: 'An overview of accessible home studio equipment.',
      },
      {
        entity_type: 'video',
        url: 'https://www.youtube.com/watch?v=video004',
        title: 'YouTube video brief 4',
        author: 'Creator Delta',
        summary: 'A creator interview about building an audience.',
      },
      {
        entity_type: 'video',
        url: 'https://www.youtube.com/watch?v=video005',
        title: 'YouTube video brief 5',
        author: 'Creator Epsilon',
        summary: 'A comparison of popular video production workflows.',
      },
      {
        entity_type: 'video',
        url: 'https://www.youtube.com/watch?v=video006',
        title: 'YouTube video brief 6',
        author: 'Creator Zeta',
        summary: 'Tips for organizing a consistent publishing schedule.',
      },
    ]

    const documentState = {
      document: {
        id: 9101,
        user_id: 1,
        workspace_root: 'browser-local-workspace',
        path: documentPath,
        title: tableTitle,
        description: '',
        icon: '',
        color: '',
        meta: null,
        tables: [
          {
            id: 9102,
            user_id: 1,
            document_id: 9101,
            name: 'youtube_sync',
            title: tableTitle,
            description: '',
            order: 1,
            primary_field_id: 9103,
            meta: null,
            fields: [
              {
                id: 9103,
                user_id: 1,
                document_id: 9101,
                table_id: 9102,
                name: 'title',
                title: 'Title',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: true,
                order: 1,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
              {
                id: 9104,
                user_id: 1,
                document_id: 9101,
                table_id: 9102,
                name: 'status',
                title: 'Status',
                type: 'single_select',
                required: false,
                unique: false,
                readonly: false,
                is_primary: false,
                order: 2,
                options: {
                  choices: ['New'],
                },
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
            ],
            views: [
              {
                id: 9105,
                user_id: 1,
                document_id: 9101,
                table_id: 9102,
                title: 'Grid',
                type: 'grid',
                order: 1,
                locked: false,
                config: null,
                created_at: now,
                updated_at: now,
              },
            ],
            created_at: now,
            updated_at: now,
          },
        ],
        created_at: now,
        updated_at: now,
      },
      records: [] as Array<Record<string, unknown>>,
    }

    let streamRequestCount = 0
    const streamRequests: Array<Record<string, unknown>> = []

    await page.route('**/api/v1/agent/capabilities', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: {
          tools: [],
          skills: [],
          adapters: [],
          governance: {
            permission_mode: 'workspace-write',
            sandbox_enabled: true,
            shell_enabled: false,
          },
          surfaces: {
            http: true,
            ndjson_stream: true,
          },
        },
      })
    })

    await page.route('**/api/v1/agent/adapters', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: {
          items: [],
        },
      })
    })

    await page.route(/\/api\/v1\/data-documents(?:\?.*)?$/, async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: { items: [documentState.document], total: 1, offset: 0, limit: 100 },
      })
    })

    await page.route('**/api/v1/data-documents/open', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: documentState.document,
      })
    })

    await page.route('**/api/v1/data-documents/*/tables/*/records**', async (route) => {
      const method = route.request().method()
      if (method === 'GET') {
        await fulfillJson(route, {
          code: 200,
          data: {
            items: documentState.records,
            total: documentState.records.length,
            offset: 0,
            limit: 100,
          },
        })
        return
      }
      await route.fallback()
    })

    await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
      streamRequestCount += 1
      const requestBody = route.request().postDataJSON() as Record<string, unknown>
      streamRequests.push(requestBody)
      const browserContext = requestBody.browser_context as {
        adapter?: string
        command?: string
        entity_type?: string
        extracted_entities?: unknown[]
      } | undefined
      const hasRequestedExtraction =
        browserContext?.adapter === 'youtube' &&
        browserContext.command === 'extract-list' &&
        browserContext.entity_type === 'video' &&
        Boolean(browserContext.extracted_entities?.length)
      if (streamRequestCount <= 2) {
        const eventBaseId = 9200 + (streamRequestCount * 10)
        await fulfillNdjson(route, [
          {
            type: 'user_message',
            chat_message: {
              id: eventBaseId + 1,
              session_id: 701,
              user_id: 1,
              role: 'user',
              content: String(requestBody.content || ''),
              status: 'completed',
              created_at: now,
            },
          },
          {
            type: 'agent_event',
            event: {
              id: eventBaseId + 2,
              session_id: 701,
              user_id: 1,
              event_type: 'browser.open_required',
              stage: 'browser',
              status: 'completed',
              label: 'Open browser tab',
              message: 'Open youtube.com in the browser tab first.',
              data: {
                action: 'open_embedded_browser',
                provider: 'generic-web',
                adapter: 'youtube',
                command: 'extract-list',
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
            done: true,
            extra_data: {
              session: {
                id: 701,
                user_id: 1,
                title: 'YouTube Sync',
                workspace_root: 'browser-local-workspace',
                active_document_path: documentPath,
                status: 'idle',
                created_at: now,
                updated_at: now,
              },
            },
          },
        ])
        return
      }

      if (!hasRequestedExtraction) {
        await fulfillNdjson(route, [
          {
            type: 'done',
            done: true,
            extra_data: {
              message: {
                id: 9250,
                session_id: 701,
                user_id: 1,
                role: 'assistant',
                content: 'Browser extraction metadata was missing.',
                status: 'failed',
                created_at: now,
              },
            },
          },
        ])
        return
      }

      documentState.document = {
        ...documentState.document,
        tables: [
          {
            ...documentState.document.tables[0],
            fields: [
              ...documentState.document.tables[0].fields,
              {
                id: 9106,
                user_id: 1,
                document_id: 9101,
                table_id: 9102,
                name: 'url',
                title: 'URL',
                type: 'url',
                required: false,
                unique: true,
                readonly: false,
                is_primary: false,
                order: 3,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
              {
                id: 9107,
                user_id: 1,
                document_id: 9101,
                table_id: 9102,
                name: 'source',
                title: 'Source',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: false,
                order: 4,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
            ],
          },
        ],
        updated_at: '2026-05-20T12:00:02.000Z',
      }
      documentState.records = browserEntities.map((entity, index) => ({
        id: 9300 + index,
        user_id: 1,
        document_id: 9101,
        table_id: 9102,
        row_key: `row-${index + 1}`,
        order: index + 1,
        values: {
          title: entity.title,
          status: 'New',
          url: entity.url,
          source: 'youtube.com',
        },
        created_at: now,
        updated_at: now,
      }))

      await fulfillNdjson(route, [
        {
          type: 'delta',
          delta: 'Reading the current youtube page and preparing rows.\n',
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 9301,
            session_id: 701,
            user_id: 1,
            tool_name: 'data_table_add_fields',
            input_data: {
              fields: ['URL', 'Source'],
            },
            output_data: {
              created: ['URL', 'Source'],
            },
            status: 'completed',
            error_message: '',
            created_at: now,
            updated_at: now,
          },
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 9302,
            session_id: 701,
            user_id: 1,
            tool_name: 'data_table_add_records',
            input_data: {
              records: browserEntities,
            },
            output_data: {
              created: 6,
              updated: 0,
              skipped: 0,
              unique_by: ['URL'],
              input_record_count: 6,
            },
            status: 'completed',
            error_message: '',
            created_at: now,
            updated_at: now,
          },
        },
        {
          type: 'done',
          done: true,
          extra_data: {
            message: {
              id: 9303,
              session_id: 701,
              user_id: 1,
              role: 'assistant',
              content: 'Synced 6 records from youtube.com into the current table.',
              status: 'completed',
              created_at: now,
            },
            session: {
              id: 701,
              user_id: 1,
              title: 'YouTube Sync',
              workspace_root: 'browser-local-workspace',
              active_document_path: documentPath,
              status: 'completed',
              created_at: now,
              updated_at: '2026-05-20T12:00:03.000Z',
            },
          },
        },
      ])
    })

    await page.reload({ waitUntil: 'commit' })
    await expect(page.getByTestId('document-tree')).toBeVisible()
    const patchedBridge = await installMockBrowserBridge(page, {
      entities: browserEntities,
    })
    expect(patchedBridge).toEqual({ enabled: true })
    await page.evaluate(() => {
      window.localStorage.setItem('kition.table-agent.safe-mode.v1', 'off')
    })

    await page
      .locator('[data-testid="document-tree"] .document-tree-row')
      .filter({ hasText: tableTitle })
      .last()
      .click()
    const { sidebar, composer, sendButton } = await openUnifiedAgentChat(page)
    await composer.fill(capturePrompt)
    await sendButton.click()

    const userMessages = sidebar.locator('.agent-message[data-role="user"]')
    await expect(userMessages).toHaveCount(1)
    await expect(userMessages.nth(0)).toContainText('collect every video card')
    await expect(page.locator('.document-tab.is-browser').filter({ hasText: 'youtube.com' })).toBeVisible()
    await expect(sidebar).toBeVisible()

    await expect(
      sidebar.getByText('Synced 6 records from youtube.com into the current table.'),
    ).toBeVisible()
    await expect(userMessages).toHaveCount(1)
    expect(streamRequests).toHaveLength(3)
    expect(streamRequests[0]).toMatchObject({
      content: capturePrompt,
      browser_enabled: true,
      hide_user_message: false,
      browser_context: {
        host: 'youtube.com',
        page_url: 'https://www.youtube.com/',
        extracted_entities: browserEntities,
      },
    })
    expect(streamRequests[1]).toMatchObject({
      browser_enabled: true,
      hide_user_message: true,
      browser_context: {
        adapter: 'youtube',
        command: 'extract-list',
        entity_type: 'video',
        host: 'youtube.com',
        extracted_entities: browserEntities,
      },
    })
    expect(streamRequests[2]).toMatchObject({
      browser_enabled: true,
      hide_user_message: true,
      browser_context: {
        adapter: 'youtube',
        command: 'extract-list',
        entity_type: 'video',
        host: 'youtube.com',
        extracted_entities: browserEntities,
      },
    })
    await expect(page.getByText('The agent updated the current table.')).toHaveCount(0)
    await expect(page.locator('.document-tab.is-browser .document-tab-badge')).toHaveCount(1)
    expect(documentState.records).toHaveLength(6)
    expect(documentState.records[0]).toMatchObject({
      values: {
        title: 'YouTube video brief 1',
        source: 'youtube.com',
      },
    })
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})

test('table agent treats open-site requests as browser-only work', async ({ baseURL }) => {
  test.setTimeout(90_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-browser-only-'))
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
      waitUntil: 'commit',
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

    const tableTitle = `Browser Only ${Date.now().toString().slice(-6)}`
    const createdDocument = await page.evaluate(async (nextTitle) => {
      const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
      if (!bridge?.CreateWorkspaceDocument) {
        throw new Error('create workspace document is unavailable')
      }
      return bridge.CreateWorkspaceDocument({
        title: nextTitle,
        folder: '',
        platform: 'Research',
        format: 'data',
      })
    }, tableTitle) as {
      path: string
      name: string
    }

    const documentPath = String(createdDocument.path || '').trim()
    const now = '2026-05-20T12:00:00.000Z'

    const documentState = {
      document: {
        id: 9101,
        user_id: 1,
        workspace_root: 'browser-local-workspace',
        path: documentPath,
        title: tableTitle,
        description: '',
        icon: '',
        color: '',
        meta: null,
        tables: [
          {
            id: 9102,
            user_id: 1,
            document_id: 9101,
            name: 'browser_only',
            title: tableTitle,
            description: '',
            order: 1,
            primary_field_id: 9103,
            meta: null,
            fields: [
              {
                id: 9103,
                user_id: 1,
                document_id: 9101,
                table_id: 9102,
                name: 'title',
                title: 'Title',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: true,
                order: 1,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
            ],
            views: [
              {
                id: 9105,
                user_id: 1,
                document_id: 9101,
                table_id: 9102,
                title: 'Grid',
                type: 'grid',
                order: 1,
                locked: false,
                config: null,
                created_at: now,
                updated_at: now,
              },
            ],
            created_at: now,
            updated_at: now,
          },
        ],
        created_at: now,
        updated_at: now,
      },
      records: [] as Array<Record<string, unknown>>,
    }

    await page.route('**/api/v1/agent/capabilities', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: {
          tools: [
            { name: 'browser_open', description: 'Open a browser page', category: 'browser', permission: 'desktop', enabled: true },
            { name: 'browser_navigate', description: 'Navigate in the browser', category: 'browser', permission: 'desktop', enabled: true },
            { name: 'browser_search', description: 'Search within the browser', category: 'browser', permission: 'desktop', enabled: true },
          ],
          skills: [],
          adapters: [
            {
              adapter: 'youtube',
              label: 'YouTube',
              description: 'YouTube video feed',
              transport: 'browser',
              session_provider: 'generic-web',
              primary_host: 'youtube.com',
              host_patterns: ['www.youtube.com'],
              commands: [
                {
                  name: 'feed',
                  description: 'Read the main feed',
                  mode: 'browser',
                  entity_type: 'video',
                  auth_required: true,
                  supports_table_ingest: true,
                },
              ],
            },
          ],
          governance: {
            permission_mode: 'workspace-write',
            sandbox_enabled: true,
            shell_enabled: false,
          },
          surfaces: {
            http: true,
            ndjson_stream: true,
          },
        },
      })
    })

    await page.route('**/api/v1/agent/adapters', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: {
          items: [
            {
              adapter: 'youtube',
              label: 'YouTube',
              description: 'YouTube video feed',
              transport: 'browser',
              session_provider: 'generic-web',
              primary_host: 'youtube.com',
              host_patterns: ['www.youtube.com'],
              commands: [
                {
                  name: 'feed',
                  description: 'Read the main feed',
                  mode: 'browser',
                  entity_type: 'video',
                  auth_required: true,
                  supports_table_ingest: true,
                },
              ],
            },
          ],
        },
      })
    })

    await page.route(/\/api\/v1\/data-documents(?:\?.*)?$/, async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: { items: [documentState.document], total: 1, offset: 0, limit: 100 },
      })
    })

    await page.route('**/api/v1/data-documents/open', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: documentState.document,
      })
    })

    await page.route('**/api/v1/data-documents/*/tables/*/records**', async (route) => {
      if (route.request().method() === 'GET') {
        await fulfillJson(route, {
          code: 200,
          data: {
            items: documentState.records,
            total: documentState.records.length,
            offset: 0,
            limit: 100,
          },
        })
        return
      }
      await route.fallback()
    })

    let streamRequestCount = 0
    const streamRequests: Array<Record<string, unknown>> = []
    await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
      streamRequestCount += 1
      streamRequests.push(route.request().postDataJSON() as Record<string, unknown>)
      await fulfillNdjson(route, [
        {
          type: 'user_message',
          chat_message: {
            id: 9301,
            session_id: 702,
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
            id: 9302,
            session_id: 702,
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
	              url: 'https://www.youtube.com',
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
              id: 702,
              user_id: 1,
              title: 'Open youtube.com',
              active_document_path: documentPath,
              created_at: now,
              updated_at: now,
            },
            message: {
              id: 9303,
              session_id: 702,
              user_id: 1,
              role: 'assistant',
              content: 'Opened youtube.com. Waiting for your next instruction.',
              status: 'completed',
              created_at: now,
            },
          },
        },
      ])
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('document-tree')).toBeVisible()
    const patchedBridge = await installMockBrowserBridge(page, {
      entities: [],
      pageUrl: 'https://www.youtube.com/',
      visiblePreview: 'Home page ready.',
    })
    expect(patchedBridge).toEqual({ enabled: true })

    await page
      .locator('[data-testid="document-tree"] .document-tree-row')
      .filter({ hasText: tableTitle })
      .last()
      .click()

    const { sidebar, composer, sendButton } = await openUnifiedAgentChat(page)
    await composer.fill('Open youtube.com')
    await sendButton.click()

    await expect(sidebar.locator('.agent-message[data-role="user"]')).toContainText('Open youtube.com')
    await expect(page.locator('.document-tab.is-browser').filter({ hasText: 'youtube.com' })).toBeVisible()
    await expect(page.locator('.workspace-browser-tab')).toBeVisible()
    await expect(sidebar.getByText('Opened youtube.com. Waiting for your next instruction.')).toBeVisible()
    await expect(page.getByText('Inspect table')).toHaveCount(0)
    expect(streamRequestCount).toBe(1)
    expect(streamRequests[0]).toMatchObject({
      content: 'Open youtube.com',
      browser_enabled: true,
      hide_user_message: false,
    })
    expect(documentState.records).toHaveLength(0)
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})

test.skip('table agent keeps browser-open and write-to-table turns separate on youtube.com', async ({ baseURL }) => {
  test.setTimeout(90_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-youtube-agent-'))
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
      waitUntil: 'commit',
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

    const tableTitle = `YouTube Sync ${Date.now().toString().slice(-6)}`
    const createdDocument = await page.evaluate(async (nextTitle) => {
      const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
      if (!bridge?.CreateWorkspaceDocument) {
        throw new Error('create workspace document is unavailable')
      }
      return bridge.CreateWorkspaceDocument({
        title: nextTitle,
        folder: '',
        platform: 'Research',
        format: 'data',
      })
    }, tableTitle) as {
      path: string
      name: string
    }

    const documentPath = String(createdDocument.path || '').trim()
    const now = '2026-05-20T12:00:00.000Z'
    const browserEntities = [
      {
        entity_type: 'video',
        title: 'How companies quietly monitor workplace devices',
        author: 'Tech Explained',
        views: '233K',
        duration: '08:43',
        published_at: '05-20',
        url: 'https://www.youtube.com/watch?v=video001',
      },
      {
        entity_type: 'video',
        title: 'A fitness creator rebuilds after a health setback',
        author: 'Chris Bell',
        views: '1.4M',
        duration: '04:38',
        published_at: 'Yesterday',
        url: 'https://www.youtube.com/watch?v=video002',
      },
      {
        entity_type: 'video',
        title: 'That budget could buy several battleships',
        author: 'Eight Bowls Daily',
        views: '863K',
        duration: '01:24',
        published_at: '05-19',
        url: 'https://www.youtube.com/watch?v=video003',
      },
      {
        entity_type: 'video',
        title: 'Twin synchronization challenge',
        author: 'The Fruit Twins',
        views: '128K',
        duration: '03:19',
        published_at: '05-19',
        url: 'https://www.youtube.com/watch?v=video004',
      },
      {
        entity_type: 'video',
        title: 'Can blood replacement, cryonics, or gene editing extend life?',
        author: 'Sunstar',
        views: '306K',
        duration: '08:11',
        published_at: 'Yesterday',
        url: 'https://www.youtube.com/watch?v=video005',
      },
      {
        entity_type: 'video',
        title: 'Secret Garden recommended video',
        author: 'Secret Garden',
        views: '91K',
        duration: '06:20',
        published_at: '05-16',
        url: 'https://www.youtube.com/watch?v=video006',
      },
      {
        entity_type: 'video',
        title: 'Movie trivia recommended video',
        author: 'Movie Trivia',
        views: '154K',
        duration: '05:07',
        published_at: '05-20',
        url: 'https://www.youtube.com/watch?v=video007',
      },
      {
        entity_type: 'video',
        title: 'Food culture recommended video',
        author: 'Food Culture',
        views: '112K',
        duration: '07:36',
        published_at: 'Yesterday',
        url: 'https://www.youtube.com/watch?v=video008',
      },
    ]

    const documentState = {
      document: {
        id: 9401,
        user_id: 1,
        workspace_root: 'browser-local-workspace',
        path: documentPath,
        title: tableTitle,
        description: '',
        icon: '',
        color: '',
        meta: null,
        tables: [
          {
            id: 9402,
            user_id: 1,
            document_id: 9401,
            name: 'youtube_sync',
            title: tableTitle,
            description: '',
            order: 1,
            primary_field_id: 9403,
            meta: null,
            fields: [
              {
                id: 9403,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                name: 'title',
                title: 'Title',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: true,
                order: 1,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
              {
                id: 9404,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                name: 'status',
                title: 'Status',
                type: 'single_select',
                required: false,
                unique: false,
                readonly: false,
                is_primary: false,
                order: 2,
                options: {
                  choices: ['New'],
                },
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
            ],
            views: [
              {
                id: 9405,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                title: 'Grid',
                type: 'grid',
                order: 1,
                locked: false,
                config: null,
                created_at: now,
                updated_at: now,
              },
            ],
            created_at: now,
            updated_at: now,
          },
        ],
        created_at: now,
        updated_at: now,
      },
      records: [] as Array<Record<string, unknown>>,
    }

    let streamRequestCount = 0

    await page.route('**/api/v1/agent/capabilities', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: {
          tools: [
            { name: 'browser_open', description: 'Open a browser page', category: 'browser', permission: 'desktop', enabled: true },
            { name: 'browser_navigate', description: 'Navigate in the browser', category: 'browser', permission: 'desktop', enabled: true },
            { name: 'browser_search', description: 'Search within the browser', category: 'browser', permission: 'desktop', enabled: true },
          ],
          skills: [],
          adapters: [
            {
              adapter: 'youtube',
              label: 'YouTube',
              description: 'YouTube homepage feed',
              transport: 'browser',
              session_provider: 'generic-web',
              primary_host: 'youtube.com',
              host_patterns: ['www.youtube.com'],
              commands: [
                {
                  name: 'feed',
                  description: 'Read the homepage feed',
                  mode: 'browser',
                  entity_type: 'video',
                  auth_required: false,
                  supports_table_ingest: true,
                },
              ],
            },
          ],
          governance: {
            permission_mode: 'workspace-write',
            sandbox_enabled: true,
            shell_enabled: false,
          },
          surfaces: {
            http: true,
            ndjson_stream: true,
          },
        },
      })
    })

    await page.route('**/api/v1/agent/adapters', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: {
          items: [
            {
              adapter: 'youtube',
              label: 'YouTube',
              description: 'YouTube homepage feed',
              transport: 'browser',
              session_provider: 'generic-web',
              primary_host: 'youtube.com',
              host_patterns: ['www.youtube.com'],
              commands: [
                {
                  name: 'feed',
                  description: 'Read the homepage feed',
                  mode: 'browser',
                  entity_type: 'video',
                  auth_required: false,
                  supports_table_ingest: true,
                },
              ],
            },
          ],
        },
      })
    })

    await page.route(/\/api\/v1\/data-documents(?:\?.*)?$/, async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: { items: [documentState.document], total: 1, offset: 0, limit: 100 },
      })
    })

    await page.route('**/api/v1/data-documents/open', async (route) => {
      await fulfillJson(route, {
        code: 200,
        data: documentState.document,
      })
    })

    await page.route('**/api/v1/data-documents/*/tables/*/records**', async (route) => {
      const method = route.request().method()
      if (method === 'GET') {
        await fulfillJson(route, {
          code: 200,
          data: {
            items: documentState.records,
            total: documentState.records.length,
            offset: 0,
            limit: 100,
          },
        })
        return
      }
      await route.fallback()
    })

    await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
      streamRequestCount += 1
      if (streamRequestCount === 1) {
        await fulfillNdjson(route, [
          {
            type: 'user_message',
            chat_message: {
              id: 9501,
              session_id: 801,
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
              id: 9502,
              session_id: 801,
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
                id: 801,
                user_id: 1,
                title: 'Open youtube.com',
                active_document_path: documentPath,
                created_at: now,
                updated_at: now,
              },
              message: {
                id: 9503,
                session_id: 801,
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

      documentState.document = {
        ...documentState.document,
        tables: [
          {
            ...documentState.document.tables[0],
            fields: [
              ...documentState.document.tables[0].fields,
              {
                id: 9406,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                name: 'author',
                title: 'Author',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: false,
                order: 3,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
              {
                id: 9407,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                name: 'views',
                title: 'Views',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: false,
                order: 4,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
              {
                id: 9408,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                name: 'duration',
                title: 'Duration',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: false,
                order: 5,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
              {
                id: 9409,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                name: 'published_at',
                title: 'Published',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: false,
                order: 6,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
              {
                id: 9410,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                name: 'video_url',
                title: 'Video URL',
                type: 'url',
                required: false,
                unique: true,
                readonly: false,
                is_primary: false,
                order: 7,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
              {
                id: 9411,
                user_id: 1,
                document_id: 9401,
                table_id: 9402,
                name: 'source',
                title: 'Source',
                type: 'text',
                required: false,
                unique: false,
                readonly: false,
                is_primary: false,
                order: 8,
                options: null,
                formula: '',
                ai_prompt: '',
                meta: null,
                created_at: now,
                updated_at: now,
              },
            ],
          },
        ],
        updated_at: '2026-05-20T12:00:02.000Z',
      }
      documentState.records = browserEntities.map((entity, index) => ({
        id: 9600 + index,
        user_id: 1,
        document_id: 9401,
        table_id: 9402,
        row_key: `row-${index + 1}`,
        order: index + 1,
        values: {
          title: entity.title,
          status: 'New',
          author: entity.author,
          views: entity.views,
          duration: entity.duration,
          published_at: entity.published_at,
          video_url: entity.url,
          source: 'youtube.com',
        },
        created_at: now,
        updated_at: now,
      }))

      await fulfillNdjson(route, [
        {
          type: 'delta',
          delta: 'Reading the current youtube page and shaping rows from the rendered content.\n',
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 9601,
            session_id: 801,
            user_id: 1,
            tool_name: 'data_table_add_fields',
            input_data: {
              fields: ['Author', 'Views', 'Duration', 'Published', 'Video URL', 'Source'],
            },
            output_data: {
              created: ['Author', 'Views', 'Duration', 'Published', 'Video URL', 'Source'],
            },
            status: 'completed',
            error_message: '',
            created_at: now,
            updated_at: now,
          },
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 9602,
            session_id: 801,
            user_id: 1,
            tool_name: 'data_table_add_records',
            input_data: {
              records: browserEntities,
            },
            output_data: {
              created: 8,
              updated: 0,
              skipped: 0,
              unique_by: ['Video URL'],
              input_record_count: 8,
            },
            status: 'completed',
            error_message: '',
            created_at: now,
            updated_at: now,
          },
        },
        {
          type: 'done',
          done: true,
          extra_data: {
            message: {
              id: 9603,
              session_id: 801,
              user_id: 1,
              role: 'assistant',
              content: 'Wrote 8 youtube.com videos into the current table.',
              status: 'completed',
              created_at: now,
            },
            session: {
              id: 801,
              user_id: 1,
              title: 'YouTube Sync',
              workspace_root: 'browser-local-workspace',
              active_document_path: documentPath,
              status: 'completed',
              created_at: now,
              updated_at: '2026-05-20T12:00:03.000Z',
            },
          },
        },
      ])
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('document-tree')).toBeVisible()
    const patchedBridge = await installMockBrowserBridge(page, {
      entities: browserEntities,
      pageUrl: 'https://www.youtube.com/',
      pageTitle: 'youtube',
      host: 'youtube.com',
      heading: 'Recommended videos',
      contentPreview: 'YouTube home feed with multiple recommended videos.',
      visiblePreview: 'YouTube page ready for sync.',
    })
    expect(patchedBridge).toEqual({ enabled: true })
    await page.evaluate(() => {
      window.localStorage.setItem('kition.table-agent.safe-mode.v1', 'off')
    })

    await page
      .locator('[data-testid="document-tree"] .document-tree-row')
      .filter({ hasText: tableTitle })
      .last()
      .click()

    const { sidebar, composer, sendButton } = await openUnifiedAgentChat(page)
    await composer.fill('Open youtube.com')
    await sendButton.click()

    const userMessages = sidebar.locator('.agent-message[data-role="user"]')
    await expect(userMessages).toHaveCount(1)
    await expect(userMessages.nth(0)).toContainText('Open youtube.com')
    await expect(sidebar).toContainText('Opened youtube.com in the browser tab and kept this chat active.')
    await expect(page.locator('.document-tab.is-browser').filter({ hasText: 'youtube.com' })).toBeVisible()
    await expect(page.getByText('Continue the current youtube.com')).toHaveCount(0)

    await composer.fill('Write the data into the table')
    await sendButton.click()

    await expect(userMessages).toHaveCount(2)
    await expect(userMessages.nth(0)).toContainText('Open youtube.com')
    await expect(userMessages.nth(1)).toContainText('Write the data into the table')
    await expect(
      sidebar.getByText('Wrote 8 youtube.com videos into the current table.'),
    ).toBeVisible()
    expect(documentState.records).toHaveLength(8)
    expect(documentState.records[0]).toMatchObject({
      values: {
        title: 'How companies quietly monitor workplace devices',
        author: 'Tech Explained',
        video_url: 'https://www.youtube.com/watch?v=video001',
        source: 'youtube.com',
      },
    })
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
