import type { EmailProviderId } from './emailProviderCatalog'

export type SharedEmailProviderAccount = {
  username: string
  password: string
  hasStoredCredential: boolean
  onCredentialAccepted: () => void | Promise<void>
}

export function emailProviderCredentialKey(providerId: EmailProviderId): string {
  return `kition.email-provider.${providerId}.credential.v1`
}

export function emailProviderUsernameKey(providerId: EmailProviderId): string {
  return `kition.email-provider.${providerId}.username.v1`
}
