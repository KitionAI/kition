# Email Connections

Kition workflows send email through reusable SMTP connections. Create one from
the workflow's **Send email** action (**New connection**): choose a provider,
enter the account address and the provider credential, and **Test & Save**.

## Built-In Providers

| Provider | SMTP | Credential |
| --- | --- | --- |
| Gmail | `smtp.gmail.com:587` STARTTLS | Google app password |
| Outlook / Microsoft 365 | `smtp.office365.com:587` STARTTLS | App password when required |
| Yahoo Mail | `smtp.mail.yahoo.com:465` TLS | Yahoo app password |
| iCloud Mail | `smtp.mail.me.com:587` STARTTLS | Apple app-specific password |
| 163 Mail | `smtp.163.com:465` TLS | Client authorization code |
| 126 Mail | `smtp.126.com:465` TLS | Client authorization code |
| QQ Mail | `smtp.qq.com:465` TLS | Client authorization code |
| Foxmail | `smtp.qq.com:465` TLS | Client authorization code |
| Zoho Mail | `smtp.zoho.com:465` TLS | App password when required |
| Fastmail | `smtp.fastmail.com:465` TLS | Fastmail app password |
| GMX Mail | `mail.gmx.com:587` STARTTLS | Email password |
| Mail.com | `smtp.mail.com:587` STARTTLS | Email password |
| Proton Mail Bridge | `127.0.0.1:1025` STARTTLS | Bridge-generated password |
| Custom SMTP | User supplied | Password or token |

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
can be selected, or a new one created with **New connection**.
