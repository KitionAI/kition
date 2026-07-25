import type { Page } from '@playwright/test'

/**
 * mockSuppressLauncher hides the desktop "select vault" launcher screen
 * so e2e specs can land directly in the workspace. Extracted from the
 * individual workflow specs that all repeated the same 50-line
 * boilerplate.
 */
export async function mockSuppressLauncher(
  page: Page,
  vaultPath = '/tmp/kition-workflow-e2e-vault',
  capabilities: string[] = [],
) {
  await page.addInitScript(({ vaultPath: vp, runtimeCapabilities }) => {
    const stateWindow = window as typeof window & Record<string, unknown>
    const vault = {
      path: vp,
      name: 'Workflow E2E Vault',
      added_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    }
    const registry = () => ({ vaults: [vault], active_vault_path: vp })
    const listResponse = () => ({ root_path: vp, items: [] })
    stateWindow.kitionDesktop = {
      shell: 'electron',
      DesktopInfo: async () => ({
        is_desktop: false,
        platform: 'darwin',
        backend_base_url: '',
        data_dir: '',
        cache_dir: '',
        logs_dir: '',
        uploads_dir: '',
        exports_dir: '',
        workspace_dir: vp,
        supports_secure_storage: false,
      }),
      BackendStatus: async () => ({
        base_url: 'http://127.0.0.1:18101',
        health_url: 'http://127.0.0.1:18101/health',
        running: true,
        last_error: '',
        logs: '',
        log_file: '',
        launch_mode: 'mock',
        binary_path: '',
        config_path: '',
        working_dir: vp,
        command: '',
        capabilities: runtimeCapabilities,
      }),
      StoreSecureValue: async () => {},
      ReadSecureValue: async (key: string) => {
        if (key === 'kition.desktop.settings.v1') {
          return JSON.stringify({
            models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-4o' } },
            providers: { openai: { enabled: true, label: 'OpenAI', baseUrl: '', apiKey: '', discoveredModels: ['gpt-4o'] } },
          })
        }
        if (key === 'desktop.provider.openai.apiKey.v1') return 'sk-stub'
        return ''
      },
      DeleteSecureValue: async () => {},
      OpenExternalURL: async () => {},
      ListVaults: async () => registry(),
      AddVault: async () => ({ vault, registry: registry() }),
      RemoveVault: async () => registry(),
      RenameVault: async () => ({ vault, registry: registry() }),
      SetActiveVault: async () => ({ list: listResponse(), registry: registry() }),
      ListWorkspaceDocuments: async () => listResponse(),
      ReadWorkspaceDocument: async () => { throw new Error('not used') },
      WriteWorkspaceDocument: async () => { throw new Error('not used') },
    }
  }, { vaultPath, runtimeCapabilities: capabilities })
}
