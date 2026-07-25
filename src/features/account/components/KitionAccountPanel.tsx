import { useEffect, useMemo, useRef } from 'react'
import {
  Check,
  CreditCard,
  ExternalLink,
  LifeBuoy,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  WalletCards,
} from 'lucide-react'

import { CreditUsageBadge } from '@/components/CreditUsageBadge'
import { KitionLogoMark } from '@/components/KitionLogoMark'
import { Button } from '@/components/ui'
import { useKitionAccount } from '@/features/account/hooks/useKitionAccount'
import { getKitionAccountLinks } from '@/features/account/lib/accountLinks'
import {
  getAccountCreditLines,
  getAccountPlanName,
  getSubscriptionStatus,
} from '@/features/account/lib/accountPresentation'
import {
  isKitionAccountAuthenticated,
  type KitionAccountStatus,
} from '@/features/account/lib/accountState'
import { useTranslation } from '@/i18n'
import { cn } from '@/lib/utils'
import { openExternalURL } from '@/services/desktop'
import {
  trackProductEvent,
  trackProductEventOnce,
} from '@/features/analytics/lib/productAnalytics'

function formatCredits(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function resolveHeading(status: KitionAccountStatus, connected: boolean, t: ReturnType<typeof useTranslation>['t']) {
  if (connected) return t('account.connectedTitle')
  if (status === 'expired') return t('account.expiredTitle')
  if (status === 'temporary_error') return t('account.unavailableTitle')
  return t('account.signedOutTitle')
}

function resolvePrimaryAction(status: KitionAccountStatus, t: ReturnType<typeof useTranslation>['t']) {
  if (status === 'loading') return t('account.checking')
  if (status === 'connecting') return t('account.waitingForSignIn')
  if (status === 'expired') return t('account.signInAgain')
  if (status === 'temporary_error') return t('account.retry')
  return t('account.signIn')
}

export function KitionAccountPanel() {
  const { t } = useTranslation('settings')
  const { state, ensureReady, cancelConnect, logout, refresh } = useKitionAccount()
  const billingReturnPendingRef = useRef(false)
  const billingWindowBlurredRef = useRef(false)
  const effectiveStatus = state.status
  const busy = effectiveStatus === 'loading' || effectiveStatus === 'connecting'
  const connected = isKitionAccountAuthenticated(effectiveStatus) && Boolean(state.session)
  const session = connected ? state.session : null
  const links = useMemo(() => getKitionAccountLinks(session), [session])
  const creditLines = useMemo(() => session ? getAccountCreditLines(session) : [], [session])

  useEffect(() => {
    function markBillingWindowBlurred() {
      if (billingReturnPendingRef.current) {
        billingWindowBlurredRef.current = true
      }
    }

    function finishBillingReturn() {
      if (!billingReturnPendingRef.current) return
      if (!billingWindowBlurredRef.current) return
      billingReturnPendingRef.current = false
      billingWindowBlurredRef.current = false
      void refresh()
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        markBillingWindowBlurred()
        return
      }
      finishBillingReturn()
    }
    window.addEventListener('blur', markBillingWindowBlurred)
    window.addEventListener('focus', finishBillingReturn)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('blur', markBillingWindowBlurred)
      window.removeEventListener('focus', finishBillingReturn)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [refresh])

  useEffect(() => {
    if (effectiveStatus === 'credits_low') {
      trackProductEventOnce('credits_low_seen', { account_state: effectiveStatus })
    } else if (effectiveStatus === 'credits_empty') {
      trackProductEventOnce('credits_exhausted_seen', { account_state: effectiveStatus })
    }
  }, [effectiveStatus])

  function openBilling(url: string) {
    trackProductEvent('billing_opened', {
      result: 'success',
      account_state: effectiveStatus,
    })
    billingReturnPendingRef.current = true
    billingWindowBlurredRef.current = false
    void openExternalURL(url)
  }

  const showTopupPrimary = effectiveStatus === 'credits_low' || effectiveStatus === 'credits_empty'
  const planName = session ? getAccountPlanName(session) : ''
  const subscription = session ? getSubscriptionStatus(session) : null
  const subscriptionLabel = subscription
    ? subscription.status === 'unknown'
      ? subscription.fallback
      : t(`account.subscription.${subscription.status}`)
    : ''

  return (
    <section
      className={cn('kition-account-panel', connected && 'is-connected')}
      data-testid="portal-profile-page"
      data-account-status={effectiveStatus}
    >
      <header className="kition-account-panel__header">
        <div className="kition-account-panel__icon" aria-hidden="true">
          {busy ? <LoaderCircle className="size-5 animate-spin" /> : <KitionLogoMark alt="" className="size-5" />}
        </div>
        <div className="min-w-0">
          <p className="kition-account-panel__eyebrow">{t('account.eyebrow')}</p>
          <h1>{resolveHeading(effectiveStatus, connected, t)}</h1>
          <p className="kition-account-panel__description">
            {connected ? t('account.connectedDescription') : t('account.signedOutDescription')}
          </p>
        </div>
      </header>

      {state.errorMessage ? (
        <div className="kition-account-panel__feedback" role="alert">
          {state.errorMessage}
        </div>
      ) : null}

      {session ? (
        <div className="kition-account-panel__content" data-testid="portal-account-summary">
          <div className="kition-account-identity">
            <div className="kition-account-identity__email">
              <span>{session.user_email || t('account.connectedAccount')}</span>
              <small>{planName}</small>
            </div>
            {subscriptionLabel ? (
              <span
                className={cn(
                  'kition-account-status-badge',
                  subscription && `is-${subscription.status}`,
                )}
                data-subscription-status={subscription?.status}
              >
                {subscriptionLabel}
              </span>
            ) : null}
          </div>

          {effectiveStatus === 'credits_low' || effectiveStatus === 'credits_empty' ? (
            <div className={cn('kition-account-credit-notice', effectiveStatus === 'credits_empty' && 'is-empty')}>
              <WalletCards className="size-4" />
              <span>{effectiveStatus === 'credits_empty' ? t('account.creditsEmpty') : t('account.creditsLow')}</span>
            </div>
          ) : null}

          {Number.isFinite(session.credit_total) && Number.isFinite(session.credit_balance) ? (
            <CreditUsageBadge
              className="kition-account-panel__credits"
              creditBalance={session.credit_balance!}
              creditTotal={session.credit_total!}
              creditResetAt={session.credit_reset_at}
              topupUrl={links.topup}
              onTopup={() => openBilling(links.topup)}
              data-testid="portal-profile-credit-summary"
            />
          ) : null}

          {creditLines.length ? (
            <div className="kition-account-credit-breakdown">
              {creditLines.map((line) => (
                <div key={line.key} className="kition-account-credit-line">
                  <span>{line.key === 'period' ? t('account.planCredits') : t('account.purchasedCredits')}</span>
                  <strong>
                    {formatCredits(line.balance)}
                    {line.total !== null ? ` / ${formatCredits(line.total)}` : ''}
                  </strong>
                </div>
              ))}
            </div>
          ) : null}

          <div className="kition-account-panel__actions">
            {showTopupPrimary ? (
              <Button onClick={() => openBilling(links.topup)} data-testid="kition-account-topup">
                <WalletCards className="size-4" />
                {t('account.topUpCredits')}
              </Button>
            ) : (
              <Button onClick={() => openBilling(links.billing)} data-testid="kition-account-manage-plan">
                <CreditCard className="size-4" />
                {t('account.managePlan')}
              </Button>
            )}
            {showTopupPrimary && links.billing !== links.topup ? (
              <Button variant="outline" onClick={() => openBilling(links.billing)}>
                <CreditCard className="size-4" />
                {t('account.managePlan')}
              </Button>
            ) : null}
            <Button variant="ghost" className="text-destructive" onClick={() => void logout()} data-testid="portal-account-logout-button">
              <LogOut className="size-4" />
              {t('account.signOut')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="kition-account-benefits">
          {[t('account.benefitHosted'), t('account.benefitNoKey'), t('account.benefitRecovery')].map((benefit) => (
            <div key={benefit} className="kition-account-benefit">
              <Check className="size-4" />
              <span>{benefit}</span>
            </div>
          ))}
          <Button
            className="kition-account-panel__primary"
            disabled={effectiveStatus === 'loading'}
            onClick={effectiveStatus === 'connecting' ? cancelConnect : () => void ensureReady()}
            data-testid="portal-account-button"
          >
            {effectiveStatus === 'connecting' ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            {effectiveStatus === 'connecting' ? t('account.cancelSignIn') : resolvePrimaryAction(effectiveStatus, t)}
          </Button>
        </div>
      )}

      <footer className="kition-account-panel__footer">
        <button type="button" onClick={() => {
          trackProductEvent('support_opened', { account_state: effectiveStatus })
          void openExternalURL(links.support)
        }}>
          <LifeBuoy className="size-3.5" />
          {t('account.support')}
        </button>
        <button type="button" onClick={() => void openExternalURL(links.terms)}>
          {t('account.terms')}
          <ExternalLink className="size-3" />
        </button>
        <button type="button" onClick={() => void openExternalURL(links.privacy)}>
          {t('account.privacy')}
          <ExternalLink className="size-3" />
        </button>
      </footer>
    </section>
  )
}
