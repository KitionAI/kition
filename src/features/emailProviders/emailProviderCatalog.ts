export type EmailProviderId =
  | 'gmail'
  | 'outlook'
  | 'yahoo'
  | 'icloud'
  | '163'
  | '126'
  | 'qq'
  | 'foxmail'
  | 'zoho'
  | 'fastmail'
  | 'gmx'
  | 'mail-com'
  | 'proton-bridge'
  | 'custom'

export type EmailTransportPreset = {
  host: string
  port: number
  tlsMode: 'tls' | 'starttls' | 'plain'
}

export type EmailProviderPreset = {
  id: EmailProviderId
  label: string
  accountHint: string
  credentialLabel: string
  credentialHint: string
  imap: EmailTransportPreset
  smtp: EmailTransportPreset
}

export const emailProviderCatalog: EmailProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    accountHint: 'you@gmail.com',
    credentialLabel: 'App password',
    credentialHint: 'Requires 2-Step Verification and a Google app password.',
    imap: { host: 'imap.gmail.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 587, tlsMode: 'starttls' },
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    accountHint: 'you@outlook.com',
    credentialLabel: 'App password',
    credentialHint: 'Use an app password when the account has multi-factor authentication enabled.',
    imap: { host: 'outlook.office365.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, tlsMode: 'starttls' },
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    accountHint: 'you@yahoo.com',
    credentialLabel: 'App password',
    credentialHint: 'Generate a Yahoo app password for third-party email clients.',
    imap: { host: 'imap.mail.yahoo.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, tlsMode: 'tls' },
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    accountHint: 'you@icloud.com',
    credentialLabel: 'App-specific password',
    credentialHint: 'Generate an app-specific password from Apple Account settings.',
    imap: { host: 'imap.mail.me.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, tlsMode: 'starttls' },
  },
  {
    id: '163',
    label: '163 Mail',
    accountHint: 'you@163.com',
    credentialLabel: 'Authorization code',
    credentialHint: 'Enable IMAP/SMTP, set the client receive range to all messages, and use the 163 Mail authorization code.',
    imap: { host: 'imap.163.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.163.com', port: 465, tlsMode: 'tls' },
  },
  {
    id: '126',
    label: '126 Mail',
    accountHint: 'you@126.com',
    credentialLabel: 'Authorization code',
    credentialHint: 'Enable IMAP/SMTP, set the client receive range to all messages, and use the 126 Mail authorization code.',
    imap: { host: 'imap.126.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.126.com', port: 465, tlsMode: 'tls' },
  },
  {
    id: 'qq',
    label: 'QQ Mail',
    accountHint: 'you@qq.com',
    credentialLabel: 'Authorization code',
    credentialHint: 'Enable IMAP/SMTP in QQ Mail and use its generated authorization code.',
    imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' },
  },
  {
    id: 'foxmail',
    label: 'Foxmail',
    accountHint: 'you@foxmail.com',
    credentialLabel: 'Authorization code',
    credentialHint: 'Foxmail accounts use QQ Mail servers and a generated authorization code.',
    imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' },
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    accountHint: 'you@example.com',
    credentialLabel: 'App password',
    credentialHint: 'Use a Zoho app password when multi-factor authentication is enabled.',
    imap: { host: 'imap.zoho.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.zoho.com', port: 465, tlsMode: 'tls' },
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    accountHint: 'you@fastmail.com',
    credentialLabel: 'App password',
    credentialHint: 'Create an app password with Mail access in Fastmail settings.',
    imap: { host: 'imap.fastmail.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, tlsMode: 'tls' },
  },
  {
    id: 'gmx',
    label: 'GMX Mail',
    accountHint: 'you@gmx.com',
    credentialLabel: 'Email password',
    credentialHint: 'Enable POP3 and IMAP access in GMX settings before connecting.',
    imap: { host: 'imap.gmx.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'mail.gmx.com', port: 587, tlsMode: 'starttls' },
  },
  {
    id: 'mail-com',
    label: 'Mail.com',
    accountHint: 'you@mail.com',
    credentialLabel: 'Email password',
    credentialHint: 'Enable POP3 and IMAP access in Mail.com settings before connecting.',
    imap: { host: 'imap.mail.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.mail.com', port: 587, tlsMode: 'starttls' },
  },
  {
    id: 'proton-bridge',
    label: 'Proton Mail Bridge',
    accountHint: 'Bridge account username',
    credentialLabel: 'Bridge password',
    credentialHint: 'Keep Proton Mail Bridge running and use the credentials shown by the local Bridge app.',
    imap: { host: '127.0.0.1', port: 1143, tlsMode: 'starttls' },
    smtp: { host: '127.0.0.1', port: 1025, tlsMode: 'starttls' },
  },
  {
    id: 'custom',
    label: 'Custom IMAP / SMTP',
    accountHint: 'you@example.com',
    credentialLabel: 'Password or token',
    credentialHint: 'Enter the server values supplied by your email administrator under Advanced.',
    imap: { host: '', port: 993, tlsMode: 'tls' },
    smtp: { host: '', port: 587, tlsMode: 'starttls' },
  },
]

export function getEmailProvider(id: EmailProviderId): EmailProviderPreset {
  return emailProviderCatalog.find((provider) => provider.id === id)
    || emailProviderCatalog[emailProviderCatalog.length - 1]
}

export function resolveEmailProviderId(
  transport: 'imap' | 'smtp',
  host: string,
  username = '',
): EmailProviderId {
  const normalizedHost = host.trim().toLowerCase()
  const normalizedUsername = username.trim().toLowerCase()
  if (normalizedUsername.endsWith('@foxmail.com')) return 'foxmail'

  return emailProviderCatalog.find((provider) => (
    provider.id !== 'custom' && provider[transport].host.toLowerCase() === normalizedHost
  ))?.id || 'custom'
}
