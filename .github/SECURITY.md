# Security Policy

## Supported Versions

| Version | Security updates |
| --- | --- |
| Latest published desktop release | Supported |
| Current `main` branch | Supported |
| Older desktop releases | Not supported |

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/KitionAI/kition/security/advisories/new)
for this repository. If that option is unavailable, email
`support@kition.ai` with:

- the affected version and operating system;
- a concise description of the impact;
- reproduction steps or a proof of concept;
- any suggested mitigation.

Do not include real user data, access tokens, API keys, signing keys, or
credentials in a report.

The maintainers will acknowledge a complete report, investigate it, and
coordinate disclosure after a fix or mitigation is available.

Please allow the maintainers time to investigate before publishing details or
sharing a proof of concept publicly.

Reports about the Rust runtime (`crates/`), the desktop shell, or a kit go
through the same private channels. Do not post exploit details in public issues
or pull requests before a fix is available.
