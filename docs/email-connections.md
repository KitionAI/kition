# Email Connections

Kition workflows send email through reusable SMTP connections. Create and test
the connection first, then select it in the workflow's **Send email** action.

Kition also imports inbox messages through IMAP. Open **Settings > Email
Providers**, choose a provider, and enter the account address plus the provider
credential. The account address and provider credential are stored once per
provider and reused by inbox and delivery workflows.

Inbox synchronization is configured from the destination Kitable. Open its
**Workflow** view, select **New Workflow**, and choose **Sync an email inbox**.
The workflow owns its mailbox, destination, schedule, attachment policy,
current progress, and run history. Email Providers does not own sync execution.

## Built-In Providers

| Provider | IMAP | SMTP | Credential |
| --- | --- | --- | --- |
| Gmail | `imap.gmail.com:993` TLS | `smtp.gmail.com:587` STARTTLS | Google app password |
| Outlook / Microsoft 365 | `outlook.office365.com:993` TLS | `smtp.office365.com:587` STARTTLS | App password when required |
| Yahoo Mail | `imap.mail.yahoo.com:993` TLS | `smtp.mail.yahoo.com:465` TLS | Yahoo app password |
| iCloud Mail | `imap.mail.me.com:993` TLS | `smtp.mail.me.com:587` STARTTLS | Apple app-specific password |
| 163 Mail | `imap.163.com:993` TLS | `smtp.163.com:465` TLS | Client authorization code |
| 126 Mail | `imap.126.com:993` TLS | `smtp.126.com:465` TLS | Client authorization code |
| QQ Mail | `imap.qq.com:993` TLS | `smtp.qq.com:465` TLS | Client authorization code |
| Foxmail | `imap.qq.com:993` TLS | `smtp.qq.com:465` TLS | Client authorization code |
| Zoho Mail | `imap.zoho.com:993` TLS | `smtp.zoho.com:465` TLS | App password when required |
| Fastmail | `imap.fastmail.com:993` TLS | `smtp.fastmail.com:465` TLS | Fastmail app password |
| GMX Mail | `imap.gmx.com:993` TLS | `mail.gmx.com:587` STARTTLS | Email password |
| Mail.com | `imap.mail.com:993` TLS | `smtp.mail.com:587` STARTTLS | Email password |
| Proton Mail Bridge | `127.0.0.1:1143` STARTTLS | `127.0.0.1:1025` STARTTLS | Bridge-generated password |
| Custom IMAP / SMTP | User supplied | User supplied | Password or token |

Provider settings can vary by account region or administrator policy. When the
provider documents different endpoints, enter those values under **Advanced**.

## TLS Modes And Ports

The SMTP port and TLS mode must match the provider configuration:

| Provider setting | Common port | Kition TLS mode |
| --- | ---: | --- |
| Implicit TLS / SMTPS | `465` | `TLS` |
| STARTTLS upgrade | `587` | `STARTTLS` |
| Unencrypted SMTP | Provider-specific | `Plain` |

Always follow the provider's documented ports. A server can close the
connection immediately when the port and TLS mode do not match, which Kition
may report as `EOF`.

## 163 Mail Example

Before creating the connection, enable the SMTP service in 163 Mail and create
an authorization code for third-party email clients. Do not use the normal web
login password.

Use these values in Kition:

| Field | Value |
| --- | --- |
| Host | `smtp.163.com` |
| Port | `465` |
| Username | The full 163 Mail address |
| Password | The 163 Mail authorization code |
| TLS | `TLS` |
| From address | The same full 163 Mail address |
| From name | Any sender name allowed by the account |

Using port `465` with `STARTTLS` is invalid for this setup and commonly returns
`EOF` during **Test & Save**.

## Attach A Connection To A Workflow

1. Open the workflow and select the **Send email** action.
2. In the **Channel** section, choose the tested SMTP connection from
   **Connection**.
3. Save the workflow changes.
4. Enable the workflow when its configuration status is valid.

The **Fix** action opens the Send email properties so an existing connection
can be selected. Use **New connection** only when another SMTP connection is
required.
