import { expect, test, type Route } from '@playwright/test'

import { installDesktopHost } from './helpers/desktopHost'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

function fulfillNdjson(route: Route, events: unknown[]) {
  return route.fulfill({
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
    },
    body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  })
}

test('workspace chat can auto-open saved docs and target @{mentions} without a bound table', async ({ page, baseURL }) => {
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

      if (streamRequestCount === 2) {
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
        return
      }

      await fulfillNdjson(route, [
        {
          type: 'user_message',
          chat_message: {
            id: 9921,
            session_id: 901,
            user_id: 1,
            role: 'user',
            content: 'Search the web for current admissions guidance, cite sources, and update this document',
            status: 'completed',
            created_at: now,
          },
        },
        {
          type: 'agent_event',
          event: {
            id: 9922,
            session_id: 901,
            user_id: 1,
            event_type: 'prompt.sent',
            stage: 'intent',
            status: 'completed',
            label: 'Send model request',
            message: 'Sent the user goal, session context, and available tools to the model',
            data: {
              model_id: 'openai:gpt-test',
              turn_capabilities: {
                available_tools: ['apply_patch', 'document_read', 'web_search'],
                hosted_web_search: { available: true, reason: 'available' },
              },
            },
            created_at: now,
          },
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 9923,
            session_id: 901,
            message_id: 9921,
            user_id: 1,
            tool_name: 'web_search',
            input_data: { query: 'current university admissions guidance' },
            output_data: {
              query: 'current university admissions guidance',
              results: [{
                title: 'Official admissions source',
                url: 'https://example.edu/admissions',
              }],
            },
            status: 'completed',
            created_at: now,
            updated_at: now,
          },
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 9924,
            session_id: 901,
            message_id: 9921,
            user_id: 1,
            tool_name: 'apply_patch',
            input_data: { path: createdDocs.mentionPath },
            output_data: {
              file_ops: [{ kind: 'update', path: createdDocs.mentionPath }],
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
              id: 9925,
              session_id: 901,
              user_id: 1,
              role: 'assistant',
              content: 'Updated the active document with current guidance. Source: [Official admissions source](https://example.edu/admissions).',
              status: 'completed',
              created_at: now,
            },
            session: {
              id: streamSessionId,
              user_id: 1,
              title: 'Chat',
              workspace_root: 'browser-local-workspace',
              active_document_path: createdDocs.mentionPath,
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

    const floatingLauncher = page.getByTestId('agent-floating-launcher')
    await expect(floatingLauncher).toBeVisible()
    await expect(floatingLauncher).toHaveCSS('width', '56px')
    await expect(floatingLauncher).toHaveCSS('height', '56px')
    await expect(floatingLauncher).toHaveCSS('bottom', '64px')
    await expect(floatingLauncher.locator('.agent-floating-launcher__icon')).toBeVisible()
    await floatingLauncher.click()
    await page.locator('button[aria-label="New chat"]').click()
    await expect(page.locator('.agent-chat-panel')).toBeVisible()
    await page.getByTestId('workspace-agent-collapse').click()
    await expect(page.locator('.agent-chat-panel')).toBeHidden()
    await expect(floatingLauncher).toBeVisible()
    await floatingLauncher.click()
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
      active_document_path: createdDocs.mentionPath,
      active_data_document_id: 0,
      active_data_table_id: 0,
      save_markdown: false,
    })

    await composer.fill(`Use @{${createdDocs.mentionPath}} and summarize it`)
    await sendButton.click()

    await expect(userMessages).toHaveCount(2)
    await expect(
      assistantMessages.nth(1).getByRole('button', {
        name: createdDocs.mentionPath,
        exact: true,
      }),
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

    await composer.fill('Search the web for current admissions guidance, cite sources, and update this document')
    await sendButton.click()

    await expect(userMessages).toHaveCount(3)
    await expect(assistantMessages.nth(2)).toContainText('Official admissions source')
    await expect(page.getByTestId('agent-hosted-web-search-status')).toHaveCount(0)
    const changedFilesCard = page.locator('.agent-changed-files').filter({ hasText: mentionTitle })
    await expect(changedFilesCard).toBeVisible()
    await changedFilesCard.locator('.agent-changed-files-head').click()
    await expect(changedFilesCard.locator('.agent-changed-file').filter({ hasText: mentionTitle })).toBeVisible()
    expect(requestBodies[2]).toMatchObject({
      active_document_path: createdDocs.mentionPath,
      active_data_document_id: 0,
      active_data_table_id: 0,
      runtime_model: {
        provider_type: 'openai',
        model_name: 'gpt-test',
        wire_api: 'responses',
      },
    })
  } finally {
    await host.dispose()
  }
})
