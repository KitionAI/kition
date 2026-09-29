import { useEffect, useState } from 'react'
import { Button } from '@/components/ui'
import {
  SettingsActionBar,
  SettingsPaneHeader,
  SettingsRow,
  SettingsSection,
} from '@/features/settings/primitives'
import {
  BRAND_COLOR_ROLES,
  DESIGN_FONT_FAMILIES,
  EMPTY_BRAND_KIT,
  useWorkspaceBrandKit,
  type BrandKitFile,
} from '@/features/design/public'
import { useTranslation } from '@/i18n'
import { listWorkspaceDocuments } from '@/services/desktop'
import { notify } from '@/lib/notify'
import { serializeBrandKit } from '@/features/design/public'

/** Edits the workspace brand kit that design templates and the Brand menu use. */
export function BrandSettings() {
  const { t } = useTranslation('settings')
  const [root, setRoot] = useState('')
  useEffect(() => {
    let mounted = true
    void listWorkspaceDocuments()
      .then((workspace) => {
        if (mounted) setRoot(workspace.root_path)
      })
      .catch(() => {
        if (mounted) setRoot('')
      })
    return () => {
      mounted = false
    }
  }, [])
  return (
    <div className="settings-pane">
      <SettingsPaneHeader title={t('brand.paneTitle')} description={t('brand.paneDescription')} />
      {root ? <BrandKitEditor root={root} /> : <div className="settings-pane-empty">{t('brand.noWorkspace')}</div>}
    </div>
  )
}

function BrandKitEditor({ root }: { root: string }) {
  const { t } = useTranslation('settings')
  const brand = useWorkspaceBrandKit(root)
  const [draft, setDraft] = useState<BrandKitFile>(EMPTY_BRAND_KIT)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  useEffect(() => {
    if (!brand.loading) setDraft(brand.kit ?? EMPTY_BRAND_KIT)
  }, [brand.kit, brand.loading])
  const update = (patch: Partial<BrandKitFile>) => setDraft((current) => ({ ...current, ...patch }))
  const setColor = (role: (typeof BRAND_COLOR_ROLES)[number], value: string) =>
    setDraft((current) => ({ ...current, colors: { ...current.colors, [role]: value || undefined } }))
  return (
    <>
      <SettingsSection title={t('brand.identitySection')}>
        <SettingsRow title={t('brand.name')} description={t('brand.nameDescription')}>
          <input
            className="settings-input"
            aria-label={t('brand.name')}
            value={draft.name ?? ''}
            onChange={(event) => update({ name: event.target.value || undefined })}
          />
        </SettingsRow>
        <SettingsRow title={t('brand.font')} description={t('brand.fontDescription')}>
          <select
            className="settings-select"
            aria-label={t('brand.font')}
            value={draft.fontFamily ?? ''}
            onChange={(event) =>
              update({ fontFamily: (event.target.value || undefined) as BrandKitFile['fontFamily'] })
            }
          >
            <option value="">{t('brand.noFont')}</option>
            {DESIGN_FONT_FAMILIES.map((font) => (
              <option key={font}>{font}</option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow title={t('brand.logo')} description={t('brand.logoDescription')}>
          <input
            className="settings-input"
            aria-label={t('brand.logo')}
            value={draft.logoPath ?? ''}
            placeholder="assets/logo.png"
            onChange={(event) => update({ logoPath: event.target.value.trim() || undefined })}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t('brand.colorsSection')} description={t('brand.colorsDescription')}>
        {BRAND_COLOR_ROLES.map((role) => (
          <SettingsRow key={role} title={t(`brand.colors.${role}`)}>
            <input
              type="color"
              aria-label={t(`brand.colors.${role}`)}
              value={draft.colors[role] ?? '#ffffff'}
              onChange={(event) => setColor(role, event.target.value)}
            />
            <Button variant="ghost" size="sm" disabled={!draft.colors[role]} onClick={() => setColor(role, '')}>
              {t('brand.clearColor')}
            </Button>
          </SettingsRow>
        ))}
      </SettingsSection>
      <SettingsActionBar
        dirty={serializeBrandKit(draft) !== serializeBrandKit(brand.kit ?? EMPTY_BRAND_KIT)}
        saving={brand.save.isPending}
        lastSavedAt={savedAt}
        saveLabel={t('brand.save')}
        onSave={() =>
          brand.save
            .mutateAsync(draft)
            .then(() => setSavedAt(Date.now()))
            .catch((error) => notify.error(t('brand.saveFailed'), { description: String(error) }))
        }
        onCancel={() => setDraft(brand.kit ?? EMPTY_BRAND_KIT)}
      />
    </>
  )
}
