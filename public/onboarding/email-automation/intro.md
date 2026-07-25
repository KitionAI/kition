# Email Automation

This onboarding guide connects personal email to two different Kition workflows:

1. **Inbox sync** imports IMAP messages into a local `.kitable` and stores each full message as Markdown.
2. **Workflow delivery** sends outbound email through a reusable SMTP connection.

Start with inbox sync. It produces useful local data without sending any email.

## What inbox sync uses and creates

This guide includes an empty, schema-complete inbox table. The recommended configuration fills that table and creates local message content folders:

```text
Getting Started/Guides/Email Automation/
├── Inbox.kitable
└── intro.md

Mail/
├── Messages/
│   └── YYYY/MM/<timestamp>-<subject>-<message-key>.md
└── Attachments/
    └── <message-key>/<attachment>
```

The included `Inbox.kitable` is empty until the first successful sync. It contains one row per imported message afterward. Select the **Document** value in any row to open the complete email as a Markdown document inside Kition.

| Table field | Purpose |
| --- | --- |
| Subject | Email subject and primary display value. |
| From | Sender name and address. |
| To | Recipient names and addresses. |
| Received At | Message timestamp. |
| Mailbox | IMAP mailbox used by the workflow. |
| Preview | Short plain-text preview for scanning. |
| Has Attachments | Indicates whether the source message contains attachments. |
| Status | Import state. |
| Message ID | Provider message identifier when available. |
| Document | Workspace-relative link to the full Markdown message. |

## Before you connect an inbox

- Enable IMAP access in the email provider's account settings.
- Create an app password or client authorization code when the provider supports one.
- Do not use a normal account password when the provider requires an app-specific credential.
- Confirm that the active runtime exposes the `email_sync` capability. Kition hides inbox sync when the runtime does not support it.
- Decide whether attachments should be downloaded. Message text is always stored locally; attachments are optional.

Credentials are encrypted by the local runtime. They are not written into Markdown documents or `.kitable` files.

## Configure the included inbox sync workflow

1. Open `Getting Started/Guides/Email Automation/Inbox.kitable`.
2. Select **Workflow**. The included workflow opens as `Scheduled trigger` followed by `Sync email inbox`.
3. Select the `Sync email inbox` action node.
4. Select the provider account and enter a clear workflow name, such as `Personal inbox`.
5. Keep the mailbox as `INBOX` unless the provider uses another mailbox name.
6. Use the recommended workspace destinations below.
7. Save the workflow, then select **Sync now** from the workflow page.

| Destination | Recommended value |
| --- | --- |
| Table path | `Getting Started/Guides/Email Automation/Inbox.kitable` |
| Markdown folder | `Mail/Messages` |
| Attachment folder | `Mail/Attachments` |
| Interval | `15` minutes |
| Download attachments | Enable only when local copies are needed. |

The schedule interval must be between 5 and 1,440 minutes. Disable the schedule when you want manual-only imports.

## Verify the first import

1. Open `Getting Started/Guides/Email Automation/Inbox.kitable` from the workspace tree.
2. Confirm that message metadata appears as table rows.
3. Select a value in the **Document** column.
4. Confirm that the full message opens as Markdown.
5. If attachment download is enabled, open the matching folder under `Mail/Attachments`.
6. Return to the email sync workflow and inspect its current run, imported, updated, skipped, and failed counts.

**Sync now** imports one incremental batch of up to 100 messages. **Sync all** starts at the first message exposed by the selected IMAP mailbox and continues through every remaining batch. Scheduled sync continues from the last successful UID.

The provider controls which history is visible through IMAP. For 163 Mail and 126 Mail, open the webmail POP3, SMTP, and IMAP settings and set the client receive range to all messages before running **Sync all**. Kition cannot import messages that the provider does not expose to IMAP.

## Common personal IMAP providers

All entries below use port `993` with **TLS** unless stated otherwise. Provider policies and regional hostnames can change, so use the provider's current documentation when it differs from this table.

| Provider | IMAP host | Credential or requirement |
| --- | --- | --- |
| Gmail or Google Workspace | `imap.gmail.com` | Google app password; IMAP access must be allowed. |
| Yahoo Mail | `imap.mail.yahoo.com` | Yahoo app password. |
| AOL Mail | `export.imap.aol.com` | AOL app password. |
| iCloud Mail | `imap.mail.me.com` | Apple app-specific password. |
| Fastmail | `imap.fastmail.com` | Fastmail app password. |
| Zoho Mail | `imap.zoho.com` | App-specific password; paid or regional accounts may use another hostname. |
| GMX.com | `imap.gmx.com` | Enable external mail client access. |
| mail.com | `imap.mail.com` | Enable external mail client access. |
| mailbox.org | `imap.mailbox.org` | Mailbox or app password. |
| Posteo | `posteo.de` | Mailbox password. |
| StartMail | `imap.startmail.com` | App password. |
| Mailfence | `imap.mailfence.com` | Plan with IMAP access and a service-specific password. |
| Runbox | `mail.runbox.com` | Account or app password. |
| Hushmail | `imap.hushmail.com` | App password and a plan with mail client access. |
| Disroot | `disroot.org` | Mailbox password. |
| Riseup | `mail.riseup.net` | Mailbox password. |
| Migadu | `imap.migadu.com` | IMAP password. |
| Purelymail | `imap.purelymail.com` | Account password. |

## Chinese personal IMAP providers

| Provider | IMAP host | Credential or requirement |
| --- | --- | --- |
| QQ Mail or Foxmail | `imap.qq.com` | IMAP authorization code. |
| NetEase 163 Mail | `imap.163.com` | IMAP authorization code; set the client receive range to all messages. Kition sends the provider-required IMAP client identity. |
| NetEase 126 Mail | `imap.126.com` | IMAP authorization code; set the client receive range to all messages. |
| NetEase Yeah.net | `imap.yeah.net` | IMAP authorization code. |
| Sina Mail | `imap.sina.com` | Enable IMAP and use an authorization code when required. |
| Sohu Mail | `imap.sohu.com` | Enable IMAP client access. |
| China Mobile 139 Mail | `imap.139.com` | Client authorization code. |
| China Telecom 189 Mail | `imap.189.cn` | Client authorization code. |

## Asian and European personal IMAP providers

| Provider | IMAP host | Credential or requirement |
| --- | --- | --- |
| Naver Mail | `imap.naver.com` | Enable IMAP and use an app password when required. |
| Daum Mail | `imap.daum.net` | App password when two-step verification is enabled. |
| Yahoo Japan Mail | `imap.mail.yahoo.co.jp` | Enable mail client access. |
| Seznam Email | `imap.seznam.cz` | Mailbox password. |
| WEB.DE | `imap.web.de` | Enable external mail client access. |
| GMX.DE | `imap.gmx.net` | Enable external mail client access. |
| T-Online Mail | `secureimap.t-online.de` | Separate email password. |

## Providers with special inbox limitations

- Microsoft consumer and Microsoft 365 accounts commonly require OAuth for IMAP. Password-based IMAP works only when the account or tenant explicitly permits it; OAuth inbox sync is not part of this version.
- Proton Mail does not expose a normal remote IMAP password. Use the local hostname, port, username, and password shown by Proton Mail Bridge on the same machine.
- Tuta does not provide standard IMAP access and cannot be used for inbox sync.
- HEY does not provide general third-party IMAP credentials.

## Incremental sync and retry behavior

Kition identifies an imported message with the workflow, mailbox, provider `UIDVALIDITY`, and message UID. A retry does not create a duplicate row or Markdown file.

- A successful message advances the cursor.
- A failed message stops the current batch so later messages are not marked complete first.
- A provider `UIDVALIDITY` change starts a new mailbox identity without overwriting prior local content.
- Deleting the workflow removes its connection and sync state but preserves imported tables, Markdown, and attachments.
- HTML email is converted to Markdown. Scripts, embedded forms, executable elements, and remote tracking images are removed during import.

## Troubleshoot inbox sync

- **Authentication failed**: use the provider's app password or authorization code instead of the normal account password.
- **Unsafe Login**: confirm that IMAP access and client authorization are enabled. Kition includes IMAP `ID` support for providers such as NetEase 163 Mail.
- **Mailbox unavailable**: confirm the mailbox name and try `INBOX`.
- **Only recent messages appeared**: the provider is limiting the history exposed to IMAP. For 163 Mail and 126 Mail, set the client receive range to all messages in the webmail POP3, SMTP, and IMAP settings, then run **Sync all** again.
- **TLS failed**: verify that port `993` uses TLS. Use STARTTLS only when the provider explicitly requires it.
- **Connection timed out**: check the firewall, VPN, proxy, and provider security controls.
- **No rows appeared**: run **Sync now** again, inspect the workflow error, and confirm the target path ends in `.kitable`.
- **Attachments are missing**: enable attachment download, then sync a message that has not already completed or recreate the workflow for a clean import target.

## Configure outbound workflow email

Inbox sync reads email through IMAP. Workflows send email through a separate reusable SMTP connection.

1. Open **Settings > Connections**.
2. Select **New connection**.
3. Choose the email SMTP channel.
4. Enter the provider settings.
5. Select **Test & Save**. Kition verifies the server before saving the connection.

| Field | Value |
| --- | --- |
| Name | A recognizable label, such as `Company SMTP`. |
| Host | The provider's SMTP hostname. |
| Port | Usually `587` for STARTTLS or `465` for TLS. |
| Username | Usually the complete sender email address. |
| Password | An app password or SMTP authorization code when required. |
| TLS | Match the provider's required security mode. |
| From address | The verified sender address, usually the same as the username. |
| From name | The sender name shown to recipients. |

## Common personal SMTP providers

| Provider | Host | Port | TLS | Credential or requirement |
| --- | --- | --- | --- | --- |
| Gmail or Google Workspace | `smtp.gmail.com` | `587` | STARTTLS | Google app password. |
| Outlook.com, Hotmail, or Live | `smtp-mail.outlook.com` | `587` | STARTTLS | SMTP AUTH and an app password when permitted. |
| Microsoft 365 | `smtp.office365.com` | `587` | STARTTLS | SMTP AUTH must be permitted by the tenant. |
| Yahoo Mail | `smtp.mail.yahoo.com` | `465` | TLS | Yahoo app password. |
| AOL Mail | `smtp.aol.com` | `465` | TLS | AOL app password. |
| iCloud Mail | `smtp.mail.me.com` | `587` | STARTTLS | Apple app-specific password. |
| Fastmail | `smtp.fastmail.com` | `465` | TLS | Fastmail app password. |
| Zoho Mail | `smtp.zoho.com` | `465` | TLS | App-specific password; regional hostnames may differ. |
| GMX.com | `mail.gmx.com` | `587` | STARTTLS | Enable external mail client access. |
| mail.com | `smtp.mail.com` | `587` | STARTTLS | Account or app password. |
| mailbox.org | `smtp.mailbox.org` | `465` | TLS | Mailbox or app password. |
| Posteo | `posteo.de` | `465` | TLS | Mailbox password. |
| StartMail | `smtp.startmail.com` | `465` | TLS | App password. |
| Mailfence | `smtp.mailfence.com` | `465` | TLS | SMTP access and a service-specific password. |
| Runbox | `smtp.runbox.com` | `465` | TLS | Account or app password. |
| Hushmail | `smtp.hushmail.com` | `465` | TLS | App password and a plan with mail client access. |
| Disroot | `disroot.org` | `465` | TLS | Mailbox password. |
| Riseup | `mail.riseup.net` | `465` | TLS | Mailbox password. |
| Migadu | `smtp.migadu.com` | `465` | TLS | SMTP password. |
| Purelymail | `smtp.purelymail.com` | `465` | TLS | Account password. |
| QQ Mail or Foxmail | `smtp.qq.com` | `587` | STARTTLS | SMTP authorization code. |
| NetEase 163 Mail | `smtp.163.com` | `465` | TLS | SMTP authorization code. |
| NetEase 126 Mail | `smtp.126.com` | `465` | TLS | SMTP authorization code. |
| NetEase Yeah.net | `smtp.yeah.net` | `465` | TLS | SMTP authorization code. |
| Sina Mail | `smtp.sina.com` | `465` | TLS | SMTP authorization code. |
| Sohu Mail | `smtp.sohu.com` | `465` | TLS | SMTP authorization code. |
| China Mobile 139 Mail | `smtp.139.com` | `465` | TLS | Client authorization code. |
| China Telecom 189 Mail | `smtp.189.cn` | `465` | TLS | Client authorization code. |
| Naver Mail | `smtp.naver.com` | `465` | TLS | Enable POP3/SMTP and use an app password when required. |
| Daum Mail | `smtp.daum.net` | `465` | TLS | App password when two-step verification is enabled. |
| Yahoo Japan Mail | `smtp.mail.yahoo.co.jp` | `465` | TLS | Enable mail client access. |
| Seznam Email | `smtp.seznam.cz` | `465` | TLS | Mailbox password. |
| WEB.DE | `smtp.web.de` | `587` | STARTTLS | Enable external mail client access. |
| GMX.DE | `mail.gmx.net` | `587` | STARTTLS | Enable external mail client access. |
| T-Online Mail | `securesmtp.t-online.de` | `465` | TLS | Separate email password. |

## Connect an outbound workflow

1. Open [[../Lead Automation/Lead Follow-up.kitable]] and select **Workflows**.
2. Open the **Send email** action.
3. Select the saved SMTP connection.
4. Replace the sample recipient with an address you control.
5. Save the workflow and keep it off.
6. Send one test email and confirm the rendered subject, body, and field values.
7. Enable the workflow only after delivery succeeds.

**Run test** and **Send test email** deliver real email through the selected SMTP connection. Use the action preview when you do not want any message sent.

## Outbound troubleshooting

- Authentication failed: use an app password or SMTP authorization code instead of the account password.
- TLS handshake failed: verify that the port and TLS mode match.
- Sender rejected: make the From address match the authenticated account or a verified sender.
- Connection timed out: check the firewall, proxy, and provider SMTP access settings.

Provider security policies, regional hostnames, and plan restrictions can change. The provider's current account settings are the source of truth when they differ from this guide.
