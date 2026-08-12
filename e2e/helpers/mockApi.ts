import type { Page, Route } from '@playwright/test'

type MockLocalWorkspaceApiOptions = {
  user?: Record<string, unknown>
  discoverModelsByProvider?: Record<string, string[]>
}

const jsonHeaders = {
  'content-type': 'application/json',
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
}

export function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function mockLocalWorkspaceApi(page: Page, options: MockLocalWorkspaceApiOptions = {}) {
  const oauthAccounts = [
    {
      id: 301,
      user_id: 1,
      platform: 'wechat',
      platform_name: 'WeChat Official Account',
      account_name: 'Test Publisher Account',
      credentials: {},
      quota_used: 2400,
      quota_limit: 10000,
      is_active: true,
      last_used_at: '2026-04-21T00:00:00Z',
      expires_at: '2026-12-31T00:00:00Z',
      created_at: '2026-04-21T00:00:00Z',
      updated_at: '2026-04-21T00:00:00Z',
    },
  ]

  const oauthPlatforms = [
    {
      id: 1,
      platform_id: 'wechat',
      platform_name: 'WeChat Official Account',
      description: 'Long-form articles, analysis, and visual knowledge content',
      oauth_config: {},
      litellm_config: {},
      quota_config: {},
      is_enabled: true,
    },
  ]

  const oauthUsageLogsByAccount: Record<number, any[]> = {
    301: [
      {
        id: 801,
        account_id: 301,
        model: 'gpt-4.1-mini',
        prompt_tokens: 640,
        completion_tokens: 420,
        total_tokens: 1060,
        request_data: {},
        response_data: {},
        error_message: '',
        created_at: '2026-04-21T02:40:00Z',
      },
      {
        id: 802,
        account_id: 301,
        model: 'gpt-4.1',
        prompt_tokens: 880,
        completion_tokens: 520,
        total_tokens: 1400,
        request_data: {},
        response_data: {},
        error_message: '',
        created_at: '2026-04-20T17:15:00Z',
      },
    ],
    302: [
      {
        id: 803,
        account_id: 302,
        model: 'glm-4.5-air',
        prompt_tokens: 510,
        completion_tokens: 330,
        total_tokens: 840,
        request_data: {},
        response_data: {},
        error_message: '',
        created_at: '2026-04-20T11:20:00Z',
      },
    ],
  }

  const oauthModelsByAccount: Record<number, string[]> = {
    301: ['gpt-4.1', 'gpt-4.1-mini'],
    302: ['glm-4.5-air', 'doubao-1.5-pro'],
  }

  const templatePlatforms = [
    {
      id: 'wechat',
      name: 'WeChat Official Account',
      categories: [
        { id: 'article', name: 'Article' },
        { id: 'newsletter', name: 'Newsletter' },
      ],
    },
    {
      id: 'douyin',
      name: 'TikTok',
      categories: [{ id: 'script', name: 'Short Video Script' }],
    },
  ]

  const templates = [
    {
      id: 501,
      name: 'Long-Form Publisher Article',
      description: 'A structured article with a summary, introduction, sections, and closing action items.',
      thumbnail: '',
      platform: 'wechat',
      category: 'article',
      style: 'editorial',
      styles: {},
      format_rules: {},
      ai_prompt: '',
      content_structure: {},
      is_system: true,
      is_public: true,
      use_count: 32,
      created_at: '2026-04-10T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    },
    {
      id: 502,
      name: 'TikTok List Script',
      description: 'A conclusion-first script with concise points and closing tags.',
      thumbnail: '',
      platform: 'douyin',
      category: 'script',
      style: 'lifestyle',
      styles: {},
      format_rules: {},
      ai_prompt: '',
      content_structure: {},
      is_system: true,
      is_public: true,
      use_count: 18,
      created_at: '2026-04-08T00:00:00Z',
      updated_at: '2026-04-18T00:00:00Z',
    },
    {
      id: 503,
      name: 'Growth Retrospective',
      description: 'A team retrospective organized around data, conclusions, and next actions.',
      thumbnail: '',
      platform: 'wechat',
      category: 'article',
      style: 'analysis',
      styles: {},
      format_rules: {},
      ai_prompt: '',
      content_structure: {},
      is_system: false,
      is_public: false,
      user_id: 1,
      use_count: 6,
      created_at: '2026-04-15T00:00:00Z',
      updated_at: '2026-04-19T00:00:00Z',
    },
  ]

  const modelUsageLogs = [
    {
      id: 901,
      user_id: 1,
      ai_model_id: 1,
      creation_id: 101,
      provider: 'OpenAI',
      model_name: 'gpt-5.4',
      tool: 'wechat_article',
      request_type: 'generate',
      input_content: 'Write a long-form publisher article',
      output_content: 'Content generated',
      prompt_tokens: 900,
      completion_tokens: 720,
      total_tokens: 1620,
      status: 'success',
      error_message: null,
      response_time_ms: 1820,
      extra_data: {},
      created_at: '2026-04-21T03:00:00Z',
    },
    {
      id: 902,
      user_id: 1,
      ai_model_id: 1,
      creation_id: 102,
      provider: 'OpenAI Compatible',
      model_name: 'gpt-test',
      tool: 'twitter_thread',
      request_type: 'regenerate',
      input_content: 'Rewrite this as a thread',
      output_content: 'Content rewritten',
      prompt_tokens: 620,
      completion_tokens: 410,
      total_tokens: 1030,
      status: 'success',
      error_message: null,
      response_time_ms: 1260,
      extra_data: {},
      created_at: '2026-04-20T18:40:00Z',
    },
    {
      id: 903,
      user_id: 1,
      ai_model_id: 1,
      creation_id: null,
      provider: 'OpenAI',
      model_name: 'gpt-5.4-mini',
      tool: 'wechat_article',
      request_type: 'generate',
      input_content: 'Write cover copy',
      output_content: null,
      prompt_tokens: 540,
      completion_tokens: 0,
      total_tokens: 540,
      status: 'failed',
      error_message: 'Upstream request timed out',
      response_time_ms: 4200,
      extra_data: {},
      created_at: '2026-04-20T15:10:00Z',
    },
  ]

  const agentSessions: any[] = []
  let nextAgentSessionId = 701
  const dataImportJobs = new Map<string, any>()
  let nextDataImportJobId = 1

  await page.route('**/health', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'ok' }),
    })
  })

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (method === 'GET' && path === '/api/v1/auth/me') {
      return fulfill(route, {
        code: 200,
        data: {
          id: 1,
          username: 'local_writer',
          email: 'local@example.com',
          is_active: true,
          role: 'user',
          created_at: '2026-04-21T00:00:00Z',
          ...options.user,
        },
      })
    }

    if (method === 'GET' && path === '/api/v1/models') {
      return fulfill(route, [
        {
          id: 1,
          user_id: 1,
          name: 'Local Development Model',
          provider: 'OpenAI Compatible',
          model_name: 'gpt-test',
          api_key: '',
          is_default: true,
          is_active: true,
          is_system_builtin: false,
          capabilities: ['text'],
          created_at: '2026-04-21T00:00:00Z',
          updated_at: '2026-04-21T00:00:00Z',
        },
      ])
    }

    if (method === 'GET' && path === '/api/v1/agent/capabilities') {
      return fulfill(route, {
        code: 200,
        data: {
          tools: [
            {
              name: 'source_file_search',
              description: 'Fuzzy-search read-only local analysis paths.',
              category: 'context',
              input_schema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                },
              },
              permission: 'read-only',
              enabled: true,
            },
            {
              name: 'source_search',
              description: 'Search local analysis content with line-level evidence.',
              category: 'context',
              input_schema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  mode: { type: 'string', enum: ['literal', 'regex'] },
                },
              },
              permission: 'read-only',
              enabled: true,
            },
            {
              name: 'source_read',
              description: 'Read a bounded line range from a local analysis source.',
              category: 'context',
              input_schema: {
                type: 'object',
                properties: {
                  source_id: { type: 'string' },
                  path: { type: 'string' },
                  start_line: { type: 'integer' },
                  line_count: { type: 'integer' },
                },
              },
              permission: 'read-only',
              enabled: true,
            },
            {
              name: 'web_search',
              description: 'Search the public web with the selected model hosted search tool.',
              category: 'research',
              input_schema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                },
              },
              permission: 'network-read',
              enabled: true,
            },
            {
              name: 'image_generation',
              description: 'Generate an image and save it as a workspace artifact.',
              category: 'artifact',
              input_schema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' },
                },
              },
              permission: 'workspace-write',
              enabled: true,
            },
          ],
          skills: [],
          governance: {
            permission_mode: 'workspace-write',
            sandbox_enabled: true,
            shell_enabled: false,
          },
          surfaces: {
            http: true,
            ndjson_stream: true,
            local_source_access: true,
          },
        },
      })
    }

    if (method === 'POST' && path === '/api/v1/data-imports/preview') {
      return fulfill(route, {
        code: 200,
        data: {
          import_token: 'mock-import-token',
          source: { kind: 'upload', upload_name: 'issues.csv' },
          filename: 'issues.csv',
          format: 'csv',
          encoding: 'utf-8',
          delimiter: ',',
          row_count: 2,
          field_count: 3,
          fields: [
            { index: 0, title: 'Owner', type: 'text', nullable: false, sample_values: ['alice', 'bob'] },
            { index: 1, title: 'Status', type: 'single_select', nullable: false, options: { choices: ['Open', 'Done'] }, sample_values: ['Open', 'Done'] },
            { index: 2, title: 'Hours', type: 'number', nullable: false, sample_values: [2.5, 1] },
          ],
          sample_rows: [['alice', 'Open', 2.5], ['bob', 'Done', 1]],
          warnings: [],
          sheets: [],
        },
      })
    }

    if (method === 'POST' && path === '/api/v1/data-imports') {
      const id = `mock-import-${nextDataImportJobId++}`
      const now = '2026-04-21T04:20:00Z'
      const job = {
        id,
        status: 'completed',
        stage: 'completed',
        processed_rows: 2,
        total_rows: 2,
        result: {
          document_id: 1,
          table_id: 1,
          rows_total: 2,
          rows_created: 2,
          rows_updated: 0,
          rows_skipped: 0,
          fields_created: 3,
          fields_updated: 0,
          warnings: [],
        },
        created_at: now,
        updated_at: now,
      }
      dataImportJobs.set(id, job)
      return fulfill(route, { code: 200, data: job })
    }

    const dataImportJobMatch = path.match(/^\/api\/v1\/data-imports\/([^/]+)$/)
    if (dataImportJobMatch && method === 'GET') {
      const job = dataImportJobs.get(decodeURIComponent(dataImportJobMatch[1]))
      return fulfill(route, job
        ? { code: 200, data: job }
        : { code: 404, message: 'Import job not found' }, job ? 200 : 404)
    }
    if (dataImportJobMatch && method === 'DELETE') {
      const id = decodeURIComponent(dataImportJobMatch[1])
      const current = dataImportJobs.get(id)
      const canceled = current ? { ...current, status: 'canceled', stage: 'canceled' } : null
      if (canceled) dataImportJobs.set(id, canceled)
      return fulfill(route, canceled
        ? { code: 200, data: canceled }
        : { code: 404, message: 'Import job not found' }, canceled ? 200 : 404)
    }

    if (method === 'GET' && path === '/api/v1/agent/sessions') {
      return fulfill(route, {
        code: 200,
        data: {
          items: agentSessions,
        },
      })
    }

    if (method === 'POST' && path === '/api/v1/agent/sessions') {
      const payload = request.postDataJSON() as {
        title?: string
        active_document_path?: string
      }
      const now = '2026-04-21T04:10:00Z'
      const session = {
        id: nextAgentSessionId++,
        user_id: 1,
        title: payload.title || 'New chat',
        workspace_root: 'browser-local-workspace',
        active_document_path: payload.active_document_path || '',
        status: 'idle',
        created_at: now,
        updated_at: now,
      }

      agentSessions.unshift(session)

      return fulfill(route, {
        code: 200,
        data: session,
      })
    }

    const agentMessagesMatch = path.match(/^\/api\/v1\/agent\/sessions\/(\d+)\/messages$/)
    if (method === 'GET' && agentMessagesMatch) {
      return fulfill(route, {
        code: 200,
        data: {
          items: [],
        },
      })
    }

    const agentToolCallsMatch = path.match(/^\/api\/v1\/agent\/sessions\/(\d+)\/tool-calls$/)
    if (method === 'GET' && agentToolCallsMatch) {
      return fulfill(route, {
        code: 200,
        data: {
          items: [],
        },
      })
    }

    const agentEventsMatch = path.match(/^\/api\/v1\/agent\/sessions\/(\d+)\/events$/)
    if (method === 'GET' && agentEventsMatch) {
      return fulfill(route, {
        code: 200,
        data: {
          items: [],
        },
      })
    }

    if (method === 'GET' && path === '/api/v1/oauth/platforms') {
      return fulfill(route, {
        code: 200,
        data: oauthPlatforms,
      })
    }

    if (method === 'GET' && path === '/api/v1/oauth/accounts') {
      return fulfill(route, {
        code: 200,
        data: oauthAccounts,
      })
    }

    const oauthUsageMatch = path.match(/^\/api\/v1\/oauth\/accounts\/(\d+)\/usage$/)
    if (method === 'GET' && oauthUsageMatch) {
      const accountId = Number(oauthUsageMatch[1] || 0)
      const limit = Number(url.searchParams.get('limit') || 100)
      return fulfill(route, {
        code: 200,
        data: (oauthUsageLogsByAccount[accountId] || []).slice(0, limit),
      })
    }

    const oauthModelsMatch = path.match(/^\/api\/v1\/oauth\/accounts\/(\d+)\/models$/)
    if (method === 'GET' && oauthModelsMatch) {
      const accountId = Number(oauthModelsMatch[1] || 0)
      return fulfill(route, {
        code: 200,
        data: {
          models: oauthModelsByAccount[accountId] || [],
        },
      })
    }

    const oauthCheckMatch = path.match(/^\/api\/v1\/oauth\/accounts\/(\d+)\/check$/)
    if (method === 'POST' && oauthCheckMatch) {
      const accountId = Number(oauthCheckMatch[1] || 0)
      const account = oauthAccounts.find((item) => item.id === accountId)

      if (!account) {
        return fulfill(route, { detail: 'Account not found' }, 404)
      }

      return fulfill(route, {
        code: 200,
        data: {
          is_valid: true,
          message: `${account.account_name} passed validation`,
        },
      })
    }

    if (method === 'POST' && path === '/api/v1/oauth/accounts/manual') {
      const payload = request.postDataJSON() as {
        platform?: string
        account_name?: string
      }
      const platform = oauthPlatforms.find((item) => item.platform_id === payload.platform) || oauthPlatforms[0]
      const created = {
        id: Math.max(...oauthAccounts.map((item) => item.id), 300) + 1,
        user_id: 1,
        platform: platform.platform_id,
        platform_name: platform.platform_name,
        account_name: payload.account_name || `New ${platform.platform_name} Account`,
        credentials: {},
        quota_used: 0,
        quota_limit: 10000,
        is_active: true,
        last_used_at: '2026-04-21T03:30:00Z',
        expires_at: '2026-12-31T00:00:00Z',
        created_at: '2026-04-21T03:30:00Z',
        updated_at: '2026-04-21T03:30:00Z',
      }

      oauthAccounts.unshift(created)
      oauthUsageLogsByAccount[created.id] = []
      oauthModelsByAccount[created.id] = platform.platform_id === 'wechat' ? ['gpt-4.1-mini'] : ['glm-4.5-air']

      return fulfill(route, {
        code: 200,
        data: created,
      })
    }

    if (method === 'GET' && path === '/api/v1/templates/platforms') {
      return fulfill(route, {
        code: 200,
        data: {
          platforms: templatePlatforms,
        },
      })
    }

    if (method === 'GET' && path === '/api/v1/templates') {
      const platform = url.searchParams.get('platform') || ''
      const search = (url.searchParams.get('search') || '').trim().toLowerCase()
      const isSystem = url.searchParams.get('is_system')
      const filtered = templates.filter((item) => {
        if (platform && item.platform !== platform) {
          return false
        }
        if (isSystem === 'true' && !item.is_system) {
          return false
        }
        if (isSystem === 'false' && item.is_system) {
          return false
        }
        if (!search) {
          return true
        }
        return `${item.name} ${item.description || ''} ${item.platform}`.toLowerCase().includes(search)
      })

      return fulfill(route, {
        code: 200,
        data: {
          total: filtered.length,
          items: filtered,
        },
      })
    }

    if (method === 'POST' && path === '/api/v1/templates') {
      const created = {
        id: Math.max(...templates.map((item) => item.id), 500) + 1,
        name: 'New Custom Template',
        description: 'A basic template created from the workspace.',
        thumbnail: '',
        platform: 'wechat',
        category: 'article',
        style: 'custom',
        styles: {},
        format_rules: {},
        ai_prompt: '',
        content_structure: {},
        is_system: false,
        is_public: false,
        user_id: 1,
        use_count: 0,
        created_at: '2026-04-21T03:50:00Z',
        updated_at: '2026-04-21T03:50:00Z',
      }

      templates.unshift(created)

      return fulfill(route, {
        code: 200,
        data: created,
      })
    }

    const templateUseMatch = path.match(/^\/api\/v1\/templates\/(\d+)\/use$/)
    if (method === 'POST' && templateUseMatch) {
      const templateId = Number(templateUseMatch[1] || 0)
      const template = templates.find((item) => item.id === templateId)

      if (!template) {
        return fulfill(route, { detail: 'Template not found' }, 404)
      }

      template.use_count += 1
      template.updated_at = '2026-04-21T03:55:00Z'

      return fulfill(route, {
        code: 200,
        data: {
          message: 'ok',
          use_count: template.use_count,
        },
      })
    }

    if (method === 'GET' && path === '/api/v1/admin/model-usage/stats') {
      return fulfill(route, {
        code: 200,
        data: {
          overview: {
            total_calls: 128,
            today_calls: 18,
            week_calls: 67,
            total_tokens: 58240,
            today_tokens: 8120,
            failed_calls: 9,
            success_rate: 0.93,
          },
          by_provider: [
            { provider: 'OpenAI', count: 74, total_tokens: 32010 },
            { provider: 'OpenAI Compatible', count: 54, total_tokens: 26230 },
          ],
          by_tool: [
            { tool: 'wechat_article', count: 39, total_tokens: 18200 },
            { tool: 'twitter_thread', count: 22, total_tokens: 9100 },
          ],
        },
      })
    }

    if (method === 'GET' && path === '/api/v1/admin/model-usage/logs') {
      const provider = url.searchParams.get('provider') || ''
      const status = url.searchParams.get('status') || ''
      const pageParam = Number(url.searchParams.get('page') || 1)
      const pageSizeParam = Number(url.searchParams.get('page_size') || 20)
      const filtered = modelUsageLogs.filter((item) => {
        if (provider && item.provider !== provider) {
          return false
        }
        if (status && item.status !== status) {
          return false
        }
        return true
      })
      const start = Math.max(0, (pageParam - 1) * pageSizeParam)

      return fulfill(route, {
        code: 200,
        data: {
          total: filtered.length,
          page: pageParam,
          page_size: pageSizeParam,
          items: filtered.slice(start, start + pageSizeParam),
        },
      })
    }

    if (method === 'POST' && path === '/api/v1/desktop/providers/discover-models') {
      const payload = request.postDataJSON() as {
        provider_type?: string
      }
      const providerType = String(payload.provider_type || '')
      const models = options.discoverModelsByProvider?.[providerType] || ['gpt-test']

      return fulfill(route, {
        code: 200,
        data: {
          endpoint: providerType === 'kition_console'
            ? 'https://kition.ai/api/llm/v1/models'
            : '/models',
          models,
          fetched_at: '2026-04-21T01:23:45Z',
        },
      })
    }

    return fulfill(route, {
      code: 200,
      data: {},
    })
  })
}
