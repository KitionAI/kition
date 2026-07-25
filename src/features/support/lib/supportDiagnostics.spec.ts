import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  collectSupportDiagnostics,
  copyTextToClipboard,
  formatSupportDiagnostics,
} from './supportDiagnostics'

const baseInput = {
  appVersion: '0.1.0',
  appCommit: 'abc1234',
  buildIdentity: 'rc',
  builtAt: '2026-07-19T06:00:00Z',
  accountState: 'credits_low' as const,
  updateState: { phase: 'up-to-date' as const, currentVersion: '0.1.0' },
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getDesktopInfo: vi.fn().mockResolvedValue({
      is_desktop: true,
      platform: 'darwin',
      app_version: '0.1.0',
      backend_base_url: 'http://127.0.0.1:18101/api',
      data_dir: '/Users/member/private/data',
      cache_dir: '/Users/member/private/cache',
      logs_dir: '/Users/member/private/logs',
      uploads_dir: '/Users/member/private/uploads',
      exports_dir: '/Users/member/private/exports',
      workspace_dir: '/Users/member/Secret Workspace',
      supports_secure_storage: true,
    }),
    getDesktopBackendStatus: vi.fn().mockResolvedValue({
      base_url: 'http://127.0.0.1:18101',
      health_url: 'http://127.0.0.1:18101/health',
      running: true,
      last_error: 'token=secret-value',
      logs: 'prompt and document contents',
      log_file: '/Users/member/private/kition.log',
      launch_mode: 'managed',
      binary_path: '/Users/member/private/runtime',
      config_path: '/Users/member/private/config.json',
      working_dir: '/Users/member/Secret Workspace',
      command: 'run --api-key secret-value',
      protocol_version: 3,
    }),
    getDesktopBootstrapStatus: vi.fn().mockResolvedValue({
      official_build: true,
      build_channel: 'rc',
      available: true,
      state: 'ready',
      installation_id: 'private-installation-id',
      diagnostics: {
        code: 'startup_ready',
        title: 'Member member@example.com',
        message: 'Document: /Users/member/Secret Workspace/private.md',
        detail: 'api_key=secret-value',
        support_id: 'SUPPORT-1234',
        retryable: false,
        next_action: 'none',
      },
    }),
    ...overrides,
  }
}

describe('support diagnostics', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('formats useful coarse state without paths, content, tokens, or account identifiers', async () => {
    const snapshot = await collectSupportDiagnostics(baseInput, deps())
    const text = formatSupportDiagnostics(snapshot)

    expect(text).toContain('runtime.protocol: 3')
    expect(text).toContain('account.state: credits_low')
    expect(text).toContain('support.id: SUPPORT-1234')
    for (const sensitive of [
      '/Users/member', 'Secret Workspace', 'member@example.com', 'secret-value',
      'private.md', 'prompt and document contents', 'private-installation-id',
    ]) {
      expect(text).not.toContain(sensitive)
    }
  })

  it('redacts malformed identifiers instead of copying arbitrary server text', async () => {
    const snapshot = await collectSupportDiagnostics(
      { ...baseInput, appCommit: 'token=secret-value', buildIdentity: 'https://private.example.com' },
      deps({
        getDesktopBootstrapStatus: vi.fn().mockResolvedValue({
          official_build: false,
          build_channel: 'dev',
          available: false,
          state: 'failed with /Users/member/path',
          installation_id: 'private-installation-id',
          diagnostics: {
            code: 'network error: member@example.com',
            support_id: 'token=secret-value',
          },
        }),
      }),
    )

    expect(snapshot.appCommit).toBe('unknown')
    expect(snapshot.buildIdentity).toBe('unknown')
    expect(snapshot.startupState).toBe('unknown')
    expect(snapshot.startupCode).toBe('none')
    expect(snapshot.supportId).toBe('none')
  })

  it('classifies network failures without copying the raw update error', async () => {
    const snapshot = await collectSupportDiagnostics({
      ...baseInput,
      updateState: {
        phase: 'error',
        message: 'Failed to reach https://private.example.com?token=secret',
        errorKind: 'network',
        phaseAtError: 'checking',
      },
    }, deps())

    expect(snapshot.updateState).toBe('error')
    expect(snapshot.networkState).toBe('unavailable')
    expect(formatSupportDiagnostics(snapshot)).not.toContain('private.example.com')
  })

  it('copies the formatted report through the browser clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await copyTextToClipboard('safe diagnostics')
    expect(writeText).toHaveBeenCalledWith('safe diagnostics')
  })
})
