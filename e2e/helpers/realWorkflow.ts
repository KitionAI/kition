import { expect, type Page } from '@playwright/test'

export const REAL_API_BASE_URL = process.env.KITION_E2E_API_BASE_URL || 'http://127.0.0.1:18101/api/v1'

export type RealWorkflowFixture = {
  documentId: string
  tableId: string
  tableName: string
  fields: {
    firstName: string
    email: string
    company: string
  }
  recipient: string
}

type JsonRecord = Record<string, any>

const requiredEnv = [
  'KITION_E2E_AI_PROVIDER',
  'KITION_E2E_AI_MODEL',
  'KITION_E2E_AI_API_KEY',
  'KITION_SMTP_HOST',
  'KITION_SMTP_USERNAME',
  'KITION_SMTP_PASSWORD',
  'KITION_SMTP_FROM',
]

export function assertRealWorkflowEnv() {
  const missing = requiredEnv.filter((key) => !String(process.env[key] || '').trim())
  if (missing.length) {
    throw new Error(
      [
        'Real Workflow e2e requires live AI and SMTP configuration.',
        `Missing env: ${missing.join(', ')}`,
        'Example: KITION_E2E_AI_PROVIDER=openai KITION_E2E_AI_MODEL=gpt-4.1 KITION_E2E_AI_API_KEY=... KITION_SMTP_HOST=... KITION_SMTP_USERNAME=... KITION_SMTP_PASSWORD=... KITION_SMTP_FROM=...',
      ].join('\n'),
    )
  }
}

export function installNoRouteGuard(page: Page) {
  const originalRoute = page.route.bind(page)
  ;(page as Page & { route: Page['route'] }).route = ((...args: Parameters<Page['route']>) => {
    throw new Error(`No-mock Workflow suite forbids page.route(); attempted to route ${String(args[0])}`)
  }) as Page['route']
  return () => {
    (page as Page & { route: Page['route'] }).route = originalRoute
  }
}

export async function resetRealBackend() {
  await apiFetch('/e2e/reset', { method: 'POST' })
}

export async function createRealWorkflowFixture(): Promise<RealWorkflowFixture> {
  const stamp = Date.now().toString(36)
  const doc = await apiFetch<JsonRecord>('/data-documents', {
    method: 'POST',
    body: JSON.stringify({
      title: `Workflow E2E ${stamp}`,
      path: `workflow-e2e-${stamp}.kitable`,
      tables: [{
        title: `Leads ${stamp}`,
        name: `leads_${stamp}`,
        fields: [
          { title: 'First Name', name: 'first_name', type: 'text', primary: true, required: true },
          { title: 'Email', name: 'email', type: 'text', required: true },
          { title: 'Company', name: 'company', type: 'text' },
        ],
        views: [{ title: 'All', type: 'grid' }],
      }],
    }),
  })
  const table = doc.tables?.[0]
  if (!doc.id || !table?.id) {
    throw new Error(`Failed to create real workflow data document: ${JSON.stringify(doc)}`)
  }
  const fieldsResponse = await apiFetch<{ items?: JsonRecord[] }>(`/data-documents/${doc.id}/tables/${table.id}/fields`)
  const byName = new Map((fieldsResponse.items || []).map((field) => [String(field.name), String(field.id)]))
  const firstName = byName.get('first_name')
  const email = byName.get('email')
  const company = byName.get('company')
  if (!firstName || !email || !company) {
    throw new Error(`Expected seeded fields first_name/email/company, got ${JSON.stringify(fieldsResponse.items || [])}`)
  }
  return {
    documentId: String(doc.id),
    tableId: String(table.id),
    tableName: String(table.title || table.name),
    fields: { firstName, email, company },
    recipient: process.env.KITION_E2E_TEST_EMAIL || process.env.KITION_SMTP_FROM || 'workflow-e2e@example.com',
  }
}

export async function createRealRecord(fixture: RealWorkflowFixture, values?: Record<string, unknown>) {
  return apiFetch<JsonRecord>(`/data-documents/${fixture.documentId}/tables/${fixture.tableId}/records`, {
    method: 'POST',
    body: JSON.stringify({
      values: {
        first_name: 'Bieber',
        email: 'bieber@example.com',
        company: 'Kition Labs',
        ...(values || {}),
      },
    }),
  })
}

export async function deleteRealDataDocument(documentId: string) {
  return apiFetch<JsonRecord>(`/data-documents/${documentId}`, { method: 'DELETE' })
}

export async function fetchWorkflows() {
  return apiFetch<{ items?: JsonRecord[] }>('/workflows').then((res) => res.items || [])
}

export async function fetchConnections() {
  return apiFetch<{ items?: JsonRecord[] }>('/connections').then((res) => res.items || [])
}

export async function createRealEmailConnection() {
  const stamp = Date.now().toString(36)
  return apiFetch<JsonRecord>('/connections', {
    method: 'POST',
    body: JSON.stringify({
      channel: 'email_smtp',
      name: `Workflow E2E SMTP ${stamp}`,
      settings: {
        host: process.env.KITION_SMTP_HOST,
        port: Number(process.env.KITION_SMTP_PORT || 587),
        username: process.env.KITION_SMTP_USERNAME,
        tlsMode: process.env.KITION_SMTP_TLS_MODE || 'starttls',
        from: process.env.KITION_SMTP_FROM,
        fromName: process.env.KITION_SMTP_FROM_NAME || 'Kition E2E',
      },
      secrets: {
        password: process.env.KITION_SMTP_PASSWORD,
      },
    }),
  })
}

export async function createRealEmailConnectionFromSettings(page: Page) {
  const stamp = Date.now().toString(36)
  const name = `Workflow E2E SMTP ${stamp}`

  await page.goto('/settings?section=connections')
  await page.getByRole('tab', { name: /Email Delivery/ }).click()
  await expect(page.getByTestId('connections-settings-panel')).toBeVisible()
  await page.getByTestId('connection-new').click()
  await expect(page.getByRole('dialog', { name: 'Email connection' })).toBeVisible()

  await page.getByTestId('connection-provider').selectOption('custom')
  await page.getByRole('button', { name: 'Advanced', exact: true }).click()
  await page.getByTestId('connection-name').fill(name)
  await page.getByTestId('connection-host').fill(String(process.env.KITION_SMTP_HOST || ''))
  await page.getByTestId('connection-port').fill(String(process.env.KITION_SMTP_PORT || 587))
  await page.getByTestId('connection-username').fill(String(process.env.KITION_SMTP_USERNAME || ''))
  await page.getByTestId('connection-password').fill(String(process.env.KITION_SMTP_PASSWORD || ''))
  await page.getByTestId('connection-tls').selectOption(String(process.env.KITION_SMTP_TLS_MODE || 'starttls'))
  await page.getByTestId('connection-from').fill(String(process.env.KITION_SMTP_FROM || ''))
  await page.getByTestId('connection-from-name').fill(String(process.env.KITION_SMTP_FROM_NAME || 'Kition E2E'))
  await page.getByTestId('connection-save').click()

  await expect(page.getByRole('dialog', { name: 'Email connection' })).toHaveCount(0, { timeout: 45_000 })
  await expect(page.getByTestId('connection-card').filter({ hasText: name })).toBeVisible()

  const connections = await fetchConnections()
  const connection = connections.find((item) => item.name === name)
  if (!connection) {
    throw new Error(`Created connection ${name} was not returned by API: ${JSON.stringify(connections)}`)
  }
  return connection
}

export async function testRealConnection(id: string) {
  return apiFetch<JsonRecord>(`/connections/${id}/test`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export async function fetchWorkflow(id: string) {
  return apiFetch<JsonRecord>(`/workflows/${id}`)
}

export async function patchRealWorkflow(id: string, patch: JsonRecord) {
  return apiFetch<JsonRecord>(`/workflows/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then((res) => res.workflow || res)
}

export async function sendRealTestEmail(id: string, to?: string) {
  return apiFetch<JsonRecord>(`/workflows/${id}/send-test`, {
    method: 'POST',
    body: JSON.stringify(to ? { to } : {}),
  })
}

export async function createRealFailingRun(workflowId: string, originalTo: string) {
  await patchRealWorkflow(workflowId, { action: { to: 'not an email' } })
  try {
    await apiFetch(`/workflows/${workflowId}/send-test`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('email recipient invalid')) {
      throw error
    }
  } finally {
    await patchRealWorkflow(workflowId, { action: { to: originalTo } })
  }
  const run = await waitForRun(workflowId)
  if (run.status !== 'error') {
    throw new Error(`Expected failing send-test run, got ${JSON.stringify(run)}`)
  }
  return run
}

export async function waitForRun(workflowId: string, options: { timeoutMs?: number; recordId?: string } = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  let last: JsonRecord[] = []
  while (Date.now() < deadline) {
    const res = await apiFetch<{ runs?: JsonRecord[] }>(`/workflows/${workflowId}/runs?limit=10`)
    last = res.runs || []
    const match = options.recordId
      ? last.find((run) => String(run.recordId) === options.recordId)
      : last[0]
    if (match) {
      return match
    }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new Error(`Timed out waiting for workflow run; last runs=${JSON.stringify(last)}`)
}

export async function installRealDesktopSettings(page: Page) {
  const provider = process.env.KITION_E2E_AI_PROVIDER!
  const model = process.env.KITION_E2E_AI_MODEL!
  const apiKey = process.env.KITION_E2E_AI_API_KEY!
  const apiBaseUrl = process.env.KITION_E2E_API_BASE_URL || REAL_API_BASE_URL
  const uiApiBaseUrl = apiBaseUrl.replace(/\/v1\/?$/, '')
  const baseUrl = process.env.KITION_E2E_AI_BASE_URL || providerDefaultBaseURL(provider)
  const wireApi = process.env.KITION_E2E_AI_WIRE_API || (provider === 'anthropic' ? 'anthropic_messages' : 'responses')
  const authScheme = process.env.KITION_E2E_AI_AUTH_SCHEME || (provider === 'anthropic' ? 'x-api-key' : 'bearer')
  const reasoningEffort = process.env.KITION_E2E_AI_REASONING_EFFORT || 'medium'

  await page.addInitScript(({ provider, model, apiKey, uiApiBaseUrl, baseUrl, wireApi, authScheme, reasoningEffort }) => {
    const providerKinds = ['openai', 'anthropic', 'custom', 'kition_console']
    const providers: Record<string, any> = {}
    for (const kind of providerKinds) {
      providers[kind] = {
        kind,
        enabled: kind === provider,
        label: kind,
        baseUrl: kind === provider ? baseUrl : '',
        apiKey: kind === provider ? apiKey : '',
        accessToken: '',
        refreshToken: '',
        modelsPath: '/models',
        authHeader: '',
        authScheme,
        wireApi,
        reasoningEffort,
        hostedWebSearchVersion: '20260209',
        disableResponseStorage: true,
        discoveredModels: kind === provider ? [model] : [],
        lastSyncedAt: '',
      }
    }
    const settings = {
      general: {
        theme: 'light',
        language: 'en-US',
        restoreWorkspaceOnLaunch: false,
        confirmBeforeQuit: false,
        autoCheckUpdates: false,
        debug: false,
      },
      display: {
        zoomLevel: 1,
        density: 'normal',
        codeFontFamily: 'JetBrains Mono',
        codeFontSize: 13,
        reduceMotion: true,
        agentTimelineLineHeight: 'normal',
      },
      notifications: {
        systemNotificationsEnabled: false,
        onTaskCompleted: false,
        onTaskFailed: false,
        onUserInputNeeded: false,
        longRunningThresholdSeconds: 0,
      },
      hooks: [],
      shortcuts: [],
      providers,
      models: {
        activeProvider: provider,
        selectedModelByProvider: { [provider]: model },
        preferredDefaultModel: model,
        preferredChatModel: model,
        preferredWritingModel: model,
      },
    }
    window.localStorage.setItem('kition.desktop.settings.v1', JSON.stringify(settings))
    window.localStorage.setItem('kition.desktop.settings.backup.v1', JSON.stringify(settings))
    window.localStorage.setItem(`desktop.provider.${provider}.apiKey.v1`, apiKey)
    window.localStorage.setItem('kition.e2e.apiBaseUrl', uiApiBaseUrl)
  }, { provider, model, apiKey, uiApiBaseUrl, baseUrl, wireApi, authScheme, reasoningEffort })
}

export async function openWorkflowIndexPage(page: Page) {
  await page.goto('/documents')
  await page.evaluate(() => {
    const state = { ...(window.history.state || {}) }
    delete (state as Record<string, unknown>).workflowContext
    delete (state as Record<string, unknown>).selectedWorkflowId
    window.history.pushState(state, '', '/workflow')
    window.dispatchEvent(new PopStateEvent('popstate', { state }))
  })
  await expect(page.getByTestId('workflow-index-page')).toBeVisible()
}

export async function openWorkflowDetailPage(page: Page, workflowId: string) {
  await page.goto('/documents')
  await page.evaluate((id) => {
    const state = { ...(window.history.state || {}) }
    delete (state as Record<string, unknown>).workflowContext
    window.history.pushState({ ...state, selectedWorkflowId: id }, '', `/workflow/${id}`)
    window.dispatchEvent(new PopStateEvent('popstate', { state: { ...state, selectedWorkflowId: id } }))
  }, workflowId)
  await expect(page.getByTestId('workflow-home-page')).toBeVisible()
}

/** Jumps the AI-build entry page directly. The user-facing flow goes
 *  Index → "New Workflow" → mode dialog → "Chat with AI", but the dialog
 *  click only mutates URL state and WorkflowRoute doesn't listen for
 *  popstate (so it stays on the index view until a prop changes). For
 *  e2e we bypass the dialog by navigating + dispatching popstate from a
 *  fresh `/documents` so Shell's listener picks it up cleanly. Dialog →
 *  submit coverage lives in vitest (WorkflowRoute.spec.tsx).
 *
 *  Passing a `fixture` short-circuits the inline table picker by writing
 *  the (documentId, tableId, tableName) directly into history.state as a
 *  workflowContext — WorkflowRoute resolves that to mode 'build' which
 *  hands the tuple to WorkflowNewPage as fixed props. Without a fixture
 *  the route resolves to 'ai-no-context' and the picker is rendered
 *  (only works when the active workspace exposes a matching table label,
 *  so e2e callers should usually pass the fixture). */
export async function openWorkflowAiNewPage(page: Page, fixture?: RealWorkflowFixture) {
  await page.goto('/documents')
  await page.evaluate((context) => {
    const state = {
      ...(window.history.state || {}),
      workflowContext: context,
      workflowMode: 'ai',
    }
    window.history.pushState(state, '', '/workflow/new?mode=ai')
    window.dispatchEvent(new PopStateEvent('popstate', { state }))
  }, fixture ? {
    documentId: fixture.documentId,
    tableId: fixture.tableId,
    tableName: fixture.tableName,
  } : null)
  await expect(page.getByTestId('workflow-new-page')).toBeVisible()
}

export async function openWorkflowNewForFixture(page: Page, fixture: RealWorkflowFixture) {
  await page.evaluate((context) => {
    window.history.pushState({ ...(window.history.state || {}), workflowContext: context }, '', '/workflow/new')
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  }, { documentId: fixture.documentId, tableId: fixture.tableId, tableName: fixture.tableName })
  await expect(page.getByTestId('workflow-new-page')).toBeVisible()
}

export async function apiFetch<T = JsonRecord>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${REAL_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let payload: any = null
  if (text) {
    payload = JSON.parse(text)
  }
  if (!res.ok) {
    throw new Error(`API ${init.method || 'GET'} ${path} failed (${res.status}): ${text}`)
  }
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data as T
  }
  return payload as T
}

function providerDefaultBaseURL(provider: string) {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1'
    case 'anthropic':
      return 'https://api.anthropic.com'
    default:
      return ''
  }
}
