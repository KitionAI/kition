import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { mockAgentTurn } from './helpers/agentStream'
import { installDesktopHost } from './helpers/desktopHost'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { openInKitFrame } from './helpers/embeddedKit'
import { configureModel } from './helpers/tableAi'

test('workspace chat can auto-open saved docs and target @{mentions}', async ({ page, baseURL }) => {
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

    const turns = await mockAgentTurn(page, (turn, request) => {
      if (request.call === 1) {
        turn.tool('call_brief', 'artifact_write', { path: createdDocs.artifactPath }, { path: createdDocs.artifactPath })
        turn.deliver('call_brief', { path: createdDocs.artifactPath, description: 'Agent Notes' })
        turn.nextStep()
        turn.reply('Saved a launch brief into Agent Notes.')
        return
      }
      if (request.call === 2) {
        turn.reply(`Summarized the referenced \`${createdDocs.mentionPath}\` document.`)
        return
      }
      turn.tool('ws_1', 'web_search', { query: 'current university admissions guidance', hosted: true }, {
        query: 'current university admissions guidance',
        results: [{ title: 'Official admissions source', url: 'https://example.edu/admissions' }],
      }, { meta: { hosted: true } })
      turn.tool('call_patch', 'apply_patch', { path: createdDocs.mentionPath }, {
        file_ops: [{ kind: 'update', path: createdDocs.mentionPath }],
      })
      turn.nextStep()
      turn.reply('Updated the active document with current guidance. Source: [Official admissions source](https://example.edu/admissions).')
    })
    const requestBodies = turns.requests

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

    expect(requestBodies[0].body).toMatchObject({
      active_document_path: createdDocs.mentionPath,
      save_markdown: false,
    })
    // The agent has no table tools, so a turn names no bound table.
    expect(requestBodies[0].body).not.toHaveProperty('active_data_document_id')
    expect(requestBodies[0].body).not.toHaveProperty('active_data_table_id')

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

    expect(requestBodies[1].body).toMatchObject({
      active_document_path: createdDocs.mentionPath,
      save_markdown: false,
    })
    expect(String(requestBodies[1].body.prompt_context || '')).toContain(createdDocs.mentionPath)

    await composer.fill('Search the web for current admissions guidance, cite sources, and update this document')
    await sendButton.click()

    await expect(userMessages).toHaveCount(3)
    await expect(assistantMessages.nth(2)).toContainText('Official admissions source')
    await expect(page.getByTestId('agent-hosted-web-search-status')).toHaveCount(0)
    const changedFilesCard = page.locator('.agent-changed-files').filter({ hasText: mentionTitle })
    await expect(changedFilesCard).toBeVisible()
    await changedFilesCard.locator('.agent-changed-files-head').click()
    await expect(changedFilesCard.locator('.agent-changed-file').filter({ hasText: mentionTitle })).toBeVisible()
    expect(requestBodies[2].body).toMatchObject({
      active_document_path: createdDocs.mentionPath,
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

/**
 * AI-SCENE-001 (docs/kition-onboarding-core-scenarios.csv): with the onboarding guide open, the
 * person asks for a five-bullet summary and a first-session checklist. Every turn is bound to the
 * open guide; the write the agent reports targets that file only; a summary-only request writes
 * nothing; a write that fails is shown and leaves the guide as it was.
 */
test('AI-SCENE-001: the agent summarizes the open onboarding guide, writes only to it, and shows a failed write', async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const guide = 'Getting Started/Welcome to Kition.md'
  const original = await readFile(path.join(process.cwd(), 'public', 'onboarding', 'welcome.md'))
  await configureModel(page)
  let turns: Awaited<ReturnType<typeof mockAgentTurn>> | undefined
  const routes = async (page: Page) => {
    turns = await mockAgentTurn(page, (turn, request) => {
      const bullets = ['- Kition keeps notes, tables, workflows and kits in one workspace.', '- Everything in Getting Started is editable.', '- Tables can fill AI fields on request.', '- Workflows react to table changes.', '- The agent works on the file you have open.'].join('\n')
      if (request.call === 1) {
        turn.tool('read_1', 'document_read', { path: guide }, { path: guide })
        turn.tool('patch_1', 'apply_patch', { path: guide }, { file_ops: [{ kind: 'update', path: guide }] })
        turn.nextStep()
        turn.reply(`${bullets}\n\nI added a first-session checklist to the guide.`)
        return
      }
      if (request.call === 2) {
        turn.reply(bullets)
        return
      }
      turn.toolError('patch_2', 'apply_patch', { path: guide }, 'The guide could not be written: permission denied.')
      turn.nextStep()
      turn.reply('I could not add the checklist: the guide could not be written.')
    })
  }
  const { host, saves } = await openInKitFrame(page, baseURL!, guide, original, {}, { routes })
  try {
    await page.getByTestId('agent-floating-launcher').click()
    const composer = page.locator('.agent-ai-composer textarea')
    await expect(composer).toBeVisible()
    const assistant = page.locator('.agent-message.is-assistant')
    const changed = page.locator('.agent-changed-files')

    await composer.fill('Summarize this page in five bullets and add a checklist for my first Kition session')
    await page.locator('.agent-ai-send').click()
    await expect(assistant.nth(0)).toContainText('I added a first-session checklist to the guide.')
    await expect(changed).toHaveCount(1)
    await expect(changed.first()).toContainText('Welcome to Kition')

    await composer.fill('Summarize this page in five bullets')
    await page.locator('.agent-ai-send').click()
    await expect(assistant.nth(1)).toContainText('The agent works on the file you have open.')
    await expect(changed).toHaveCount(1)

    await composer.fill('Add the checklist again')
    await page.locator('.agent-ai-send').click()
    await expect(assistant.nth(2)).toContainText('could not add the checklist')
    await expect(page.getByText('The guide could not be written: permission denied.').first()).toBeVisible()
    await expect(changed).toHaveCount(1)

    expect(turns!.requests.map((request) => request.body.active_document_path)).toEqual([guide, guide, guide])
    // Nothing else was written: Kition saved no file, and the guide on disk is as it was.
    expect(saves).toEqual([])
    expect(await readFile(path.join(host.root, guide))).toEqual(original)
  } finally {
    await host.dispose()
  }
})
