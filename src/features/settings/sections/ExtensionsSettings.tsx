import { useState } from 'react'
import { LoaderCircle, Puzzle, Trash2 } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useExtensions, type ExtensionsApi, type InstalledExtension } from '@/features/extensions/public'
import { SettingsPaneHeader, SettingsRow, SettingsSection } from '@/features/settings/primitives'
import { useTranslation } from '@/i18n'
import { networkSources, type ExtensionManifest } from '@/lib/extensions/manifest'
import { notify } from '@/lib/notify'
import { Switch } from '@/registry/ui/switch'

/**
 * Settings > Extensions: install an extension from the workspace (a folder, its extension.json,
 * or a zip), and enable, disable, or remove installed ones.
 */
export function ExtensionsSettings() {
  const { t } = useTranslation('settings')
  const extensions = useExtensions()
  const ready = extensions?.ready ?? false
  const installed = extensions?.installed ?? []
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const install = async () => {
    if (!extensions) return
    setBusy(true)
    try {
      const extension = await extensions.install(path)
      notify.success(t('extensions.installed', { name: extension.manifest.name }))
      setPath('')
    } catch (error) {
      notify.error(t('extensions.installFailed'), { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-pane" data-testid="extensions-settings">
      <SettingsPaneHeader title={t('extensions.paneTitle')} description={t('extensions.paneDescription')} />
      <SettingsSection title={t('extensions.installSection')}>
        <SettingsRow title={t('extensions.installTitle')} description={t('extensions.installDescription')}>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (path.trim() && !busy) void install()
            }}
          >
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={t('extensions.installPlaceholder')}
              aria-label={t('extensions.installTitle')}
              className="w-64"
              spellCheck={false}
              disabled={busy}
              data-testid="extensions-install-path"
            />
            <Button type="submit" size="sm" disabled={!path.trim() || busy || !ready} data-testid="extensions-install">
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {t('extensions.install')}
            </Button>
          </form>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t('extensions.listSection')}>
        {installed.length ? (
          installed.map((extension) => <ExtensionRow key={extension.id} extension={extension} api={extensions!} />)
        ) : (
          <p className="px-1 py-3 text-sm text-muted-foreground" data-testid="extensions-empty">
            {ready ? t('extensions.empty') : <LoaderCircle className="size-4 animate-spin" />}
          </p>
        )}
      </SettingsSection>
    </div>
  )
}

function permissionLabels(manifest: ExtensionManifest, t: (key: string, options?: Record<string, unknown>) => string) {
  const labels = manifest.permissions.map((permission) => {
    if (permission === 'model.read') return t('extensions.permission.modelRead')
    if (permission === 'model.write') return t('extensions.permission.modelWrite')
    if (permission === 'commands.run') return t('extensions.permission.commandsRun')
    return t('extensions.permission.network', { origin: networkSources(permission)?.[0] ?? permission.slice('network:'.length) })
  })
  return labels.length ? labels.join(', ') : t('extensions.permission.none')
}

function ExtensionRow({ extension, api }: { extension: InstalledExtension; api: ExtensionsApi }) {
  const { t } = useTranslation('settings')
  const { manifest } = extension
  const details = [t('extensions.version', { version: manifest.version }), t('extensions.kits', { kits: manifest.activation.kits.join(', ') })]
  return (
    <div className="settings-row" data-testid="extension-row" data-extension={extension.id} data-enabled={extension.enabled}>
      <div className="settings-row-copy">
        <strong className="flex items-center gap-2">
          <Puzzle className="size-4 text-muted-foreground" aria-hidden="true" />
          {manifest.name}
        </strong>
        {manifest.description ? <p>{manifest.description}</p> : null}
        <p className="text-xs text-muted-foreground">{details.join(' · ')}</p>
        {manifest.contributes.commands.length ? (
          <p className="text-xs text-muted-foreground">
            {t('extensions.commandsLabel')}: {manifest.contributes.commands.map((command) => command.title).join(', ')}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground" data-testid="extension-permissions">
          {t('extensions.permissionsLabel')}: {permissionLabels(manifest, t)}
        </p>
      </div>
      <div className="settings-row-control flex items-center gap-3">
        <Switch
          checked={extension.enabled}
          onCheckedChange={(enabled) => void api.setEnabled(extension.id, enabled)}
          aria-label={t('extensions.enabledLabel', { name: manifest.name })}
          data-testid="extension-enabled"
        />
        <Button type="button" variant="outline" size="sm" onClick={() => void api.remove(extension.id)} aria-label={t('extensions.removeLabel', { name: manifest.name })} data-testid="extension-remove">
          <Trash2 className="size-4" aria-hidden="true" />
          {t('extensions.remove')}
        </Button>
      </div>
    </div>
  )
}
