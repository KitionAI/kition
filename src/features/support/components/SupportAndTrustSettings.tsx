import { useState } from 'react'
import { ClipboardCheck, LifeBuoy, MessageSquareText, Scale, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui'
import { useKitionAccount } from '@/features/account/hooks/useKitionAccount'
import { KITION_PRIVACY_URL, KITION_SUPPORT_URL, KITION_TERMS_URL } from '@/features/account/lib/accountLinks'
import {
  collectSupportDiagnostics,
  copyTextToClipboard,
  formatSupportDiagnostics,
} from '@/features/support/lib/supportDiagnostics'
import { SettingsRow, SettingsSection } from '@/features/settings/primitives'
import { useTranslation } from '@/i18n'
import { openExternalURL } from '@/services/desktop'
import type { UpdateState } from '@/services/desktopUpdates'
import { trackProductEvent } from '@/features/analytics/lib/productAnalytics'

const KITION_FEEDBACK_URL = 'mailto:karodong.2026@hotmail.com?subject=Kition%20Feedback'
const KITION_CONTACT_SUPPORT_URL = `${KITION_SUPPORT_URL}?subject=Kition%20Support`

export function SupportAndTrustSettings({
  appVersion,
  appCommit,
  buildIdentity,
  builtAt,
  updateState,
}: {
  appVersion: string
  appCommit: string
  buildIdentity: string
  builtAt: string
  updateState: UpdateState
}) {
  const { t } = useTranslation('settings')
  const account = useKitionAccount()
  const [copying, setCopying] = useState(false)
  const [feedback, setFeedback] = useState('')

  async function copyDiagnostics() {
    setCopying(true)
    setFeedback('')
    try {
      const snapshot = await collectSupportDiagnostics({
        appVersion,
        appCommit,
        buildIdentity,
        builtAt,
        accountState: account.state.status,
        updateState,
      })
      await copyTextToClipboard(formatSupportDiagnostics(snapshot))
      setFeedback(t('about.diagnosticsCopied'))
    } catch {
      setFeedback(t('about.diagnosticsCopyFailed'))
    } finally {
      setCopying(false)
    }
  }

  function openSupport(url: string) {
    trackProductEvent('support_opened', { account_state: account.state.status })
    void openExternalURL(url)
  }

  return (
    <>
      <SettingsSection title={t('about.supportSection')} description={t('about.supportSectionDescription')}>
        <SettingsRow title={t('about.contactSupport')} description={t('about.contactSupportDescription')}>
          <Button onClick={() => openSupport(KITION_CONTACT_SUPPORT_URL)}>
            <LifeBuoy className="size-4" />
            {t('about.contactSupportAction')}
          </Button>
        </SettingsRow>
        <SettingsRow title={t('about.sendFeedback')} description={t('about.sendFeedbackDescription')}>
          <Button variant="outline" onClick={() => openSupport(KITION_FEEDBACK_URL)}>
            <MessageSquareText className="size-4" />
            {t('about.sendFeedbackAction')}
          </Button>
        </SettingsRow>
        <SettingsRow title={t('about.copyDiagnostics')} description={t('about.copyDiagnosticsDescription')}>
          <Button variant="outline" onClick={() => void copyDiagnostics()} disabled={copying} data-testid="copy-support-diagnostics">
            <ClipboardCheck className="size-4" />
            {copying ? t('about.copyingDiagnostics') : t('about.copyDiagnosticsAction')}
          </Button>
        </SettingsRow>
        {feedback ? <div className="settings-feedback" role="status" data-testid="support-diagnostics-feedback">{feedback}</div> : null}
      </SettingsSection>
      <SettingsSection title={t('about.trustSection')}>
        <SettingsRow title={t('about.privacyPolicy')} description={t('about.privacyPolicyDescription')}>
          <Button variant="outline" onClick={() => void openExternalURL(KITION_PRIVACY_URL)}>
            <ShieldCheck className="size-4" />
            {t('about.openPrivacy')}
          </Button>
        </SettingsRow>
        <SettingsRow title={t('about.termsOfService')} description={t('about.termsOfServiceDescription')}>
          <Button variant="outline" onClick={() => void openExternalURL(KITION_TERMS_URL)}>
            <Scale className="size-4" />
            {t('about.openTerms')}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
