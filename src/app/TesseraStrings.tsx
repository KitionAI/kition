import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createStrings, StringsProvider, TESSERA_CATALOGS } from '@kition/tessera-ui'

/** Tessera's labels that Kition already translates in its `common` namespace, in every locale. */
const FROM_COMMON: Readonly<Record<string, string>> = {
  close: 'actions.close',
  confirm: 'actions.confirm',
  cancel: 'actions.cancel',
  passwordShow: 'actions.showPassword',
  passwordHide: 'actions.hidePassword',
  sheet: 'dialogs.rightSheet',
}

/**
 * Tessera's components take their labels (Close, Confirm, Show password, …) from Kition's
 * translations, so they follow the app's language; anything else falls back to Tessera's own
 * catalog for that language.
 */
export function TesseraStrings({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation('common')
  const strings = useMemo(() => {
    const own = createStrings(TESSERA_CATALOGS, i18n.language)
    return (key: string, values?: Record<string, string | number>) => (FROM_COMMON[key] ? t(FROM_COMMON[key], values) : own(key, values))
  }, [t, i18n.language])
  return <StringsProvider strings={strings}>{children}</StringsProvider>
}
