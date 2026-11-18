import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Card, Disclosure, Tabs } from '@kition/tessera-ui'
import { useTranslation } from '@/i18n'
import {
  loadBundledKits,
  loadKitionLicense,
  loadKitLicenseTexts,
  loadThirdPartyNotices,
  type BundledKit,
  type KitLicenseTexts,
} from '@/features/settings/sections/licenseTexts'

type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed' }

function useLoaded<T>(load: () => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: 'loading' })
  useEffect(() => {
    let mounted = true
    load()
      .then((value) => {
        if (mounted) setLoaded({ state: 'ready', value })
      })
      .catch(() => {
        if (mounted) setLoaded({ state: 'failed' })
      })
    return () => {
      mounted = false
    }
  }, [load])
  return loaded
}

function LicenseText({ text, label }: { text: string; label: string }) {
  return (
    <pre
      className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-5 text-foreground"
      aria-label={label}
      tabIndex={0}
    >
      {text}
    </pre>
  )
}

function LoadedText({ load, label }: { load: () => Promise<string>; label: string }) {
  const { t } = useTranslation('settings')
  const loaded = useLoaded(load)
  if (loaded.state === 'loading') return <p className="text-sm text-muted-foreground" role="status">{t('about.licenses.loading')}</p>
  if (loaded.state === 'failed') return <div className="settings-feedback" role="alert">{t('about.licenses.loadFailed')}</div>
  return <LicenseText text={loaded.value} label={label} />
}

function kitName(kit: string) {
  return kit.charAt(0).toUpperCase() + kit.slice(1)
}

function KitLicense({ kit }: { kit: BundledKit }) {
  const { t } = useTranslation('settings')
  const load = useCallback(() => loadKitLicenseTexts(kit.kit), [kit.kit])
  const loaded = useLoaded<KitLicenseTexts>(load)
  if (loaded.state === 'loading') return <p className="text-sm text-muted-foreground" role="status">{t('about.licenses.loading')}</p>
  if (loaded.state === 'failed') return <div className="settings-feedback" role="alert">{t('about.licenses.loadFailed')}</div>
  const { notice, license } = loaded.value
  if (!notice && !license) return <p className="text-sm text-muted-foreground">{t('about.licenses.kitMissing')}</p>
  const name = kitName(kit.kit)
  return (
    <div className="space-y-3">
      {notice ? (
        <div className="space-y-2">
          <strong className="block text-sm font-semibold text-foreground">{t('about.licenses.notice')}</strong>
          <LicenseText text={notice} label={t('about.licenses.kitNoticeLabel', { kit: name })} />
        </div>
      ) : null}
      {license ? (
        <div className="space-y-2">
          <strong className="block text-sm font-semibold text-foreground">{t('about.licenses.license')}</strong>
          <LicenseText text={license} label={t('about.licenses.kitLicenseLabel', { kit: name })} />
        </div>
      ) : null}
    </div>
  )
}

function KitLicenses() {
  const { t } = useTranslation('settings')
  const loaded = useLoaded(loadBundledKits)
  if (loaded.state === 'loading') return <p className="text-sm text-muted-foreground" role="status">{t('about.licenses.loading')}</p>
  if (loaded.state === 'failed') return <div className="settings-feedback" role="alert">{t('about.licenses.loadFailed')}</div>
  if (!loaded.value.length) return <p className="text-sm text-muted-foreground">{t('about.licenses.noKits')}</p>
  return (
    <div className="space-y-2">
      {loaded.value.map((kit) => (
        <Disclosure key={kit.kit} title={t('about.licenses.kitTitle', { kit: kitName(kit.kit), version: kit.version })}>
          <KitLicense kit={kit} />
        </Disclosure>
      ))}
    </div>
  )
}

/** Settings > About > Open source licenses: Kition's licence, third-party notices, and each bundled kit's NOTICE and LICENSE. */
export function OpenSourceLicenses() {
  const { t } = useTranslation('settings')
  const section = (description: string, body: ReactNode) => (
    <div className="space-y-3 pt-3">
      <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      {body}
    </div>
  )
  return (
    <div className="py-4" data-testid="open-source-licenses">
      <Card className="p-5">
        <Tabs
          items={[
            {
              key: 'kition',
              label: t('about.licenses.kitionTab'),
              children: section(t('about.licenses.kitionDescription'), <LoadedText load={loadKitionLicense} label={t('about.licenses.kitionTab')} />),
            },
            {
              key: 'third-party',
              label: t('about.licenses.thirdPartyTab'),
              children: section(t('about.licenses.thirdPartyDescription'), <LoadedText load={loadThirdPartyNotices} label={t('about.licenses.thirdPartyTab')} />),
            },
            {
              key: 'kits',
              label: t('about.licenses.kitsTab'),
              children: section(t('about.licenses.kitsDescription'), <KitLicenses />),
            },
          ]}
        />
      </Card>
    </div>
  )
}
