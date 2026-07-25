# Email Inbox Sync Implementation Plan

## Goal

Add an email sync workflow that imports new mailbox messages into a Kition table, writes each message to a Markdown document, and opens that document when the user selects the table's Document field.

The first release uses IMAP because it works with the largest set of personal email providers. Gmail API and Microsoft Graph support can be added later without changing the table or Markdown formats.

## Product Flow

1. Open the destination Kitable and select **Workflow**.
2. Choose **New Workflow > Sync an email inbox**.
3. Select a provider account, mailbox, schedule, and destination paths, then save the workflow.
4. Select **Sync now**, **Sync all**, or enable scheduled sync from the workflow page.
5. Kition creates or updates the configured `.kitable` file.
6. Each imported record contains a Document field with the generated Markdown path.
7. Selecting the Document value opens the email Markdown inside the workspace.

## MVP Scope

- IMAP over TLS or STARTTLS.
- One mailbox folder per sync workflow.
- Manual sync and interval-based scheduled sync.
- Incremental sync with a durable cursor.
- Plain-text and HTML email bodies converted to readable GitHub Flavored Markdown.
- Optional attachment download into the workspace.
- A deterministic table schema created by the runtime when the target table does not exist.
- A Markdown document for every imported message.
- Persistent run progress, results, errors, and history shown on the corresponding workflow.
- Passwords stored only by the runtime secret store and never returned by list APIs.

## Non-Goals For The MVP

- Sending or replying to email.
- Moving, deleting, starring, or marking remote messages as read.
- Gmail push notifications or Microsoft Graph webhooks.
- Thread-level merging.
- Multiple workflow actions after the import.
- Full remote mailbox management.

## Runtime Capability

The runtime advertises `email_sync` for mailbox configuration and `email_sync_runs` for persistent background executions. The client must not call email sync endpoints when `email_sync` is missing.

The public client repository contains only the contract, client, mocks, and black-box tests. IMAP access, parsing, cursor persistence, secret storage, scheduling, and filesystem writes are implemented in the private runtime repository.

## Public HTTP Contract

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/v1/email-sync/workflows` | List configured inbox sync workflows. |
| `POST` | `/v1/email-sync/workflows` | Test credentials, create a workflow, and store its secret. |
| `PATCH` | `/v1/email-sync/workflows/{id}` | Update settings; an omitted password preserves the stored secret. |
| `DELETE` | `/v1/email-sync/workflows/{id}` | Delete the workflow without deleting imported workspace files. |
| `POST` | `/v1/email-sync/workflows/{id}/test` | Verify the current stored connection. |
| `POST` | `/v1/email-sync/workflows/{id}/runs` | Start an incremental, full, or scheduled background run. |
| `GET` | `/v1/email-sync/runs?workflow_id={id}` | List persisted run progress and history for a workflow. |
| `GET` | `/v1/email-sync/runs/{id}` | Read the latest state of one run. |
| `POST` | `/v1/email-sync/runs/{id}/cancel` | Request cancellation without deleting the workflow. |
| `POST` | `/v1/email-sync/runs/{id}/retry` | Retry a failed, canceled, or interrupted run. |

The legacy synchronous `sync` and `sync-all` endpoints remain available for compatibility. New client flows use persistent runs so closing Settings or restarting the client does not hide execution state.

The normative request and response shapes are defined in `contracts/runtime/email-sync.schema.json`.

## Table Schema

| Field | Type | Behavior |
| --- | --- | --- |
| Subject | text | Primary field. |
| From | text | Normalized sender name and address. |
| To | long_text | Comma-separated recipients. |
| Received At | datetime | Provider message timestamp. |
| Mailbox | single_select | Source mailbox folder. |
| Preview | long_text | Short plain-text body preview. |
| Has Attachments | checkbox | True when the message has attachments. |
| Status | single_select | Imported, Updated, or Error. |
| Message ID | text | RFC Message-ID when present. |
| Document | document_link | Workspace-relative Markdown path. |

Runtime-managed fields are read-only. The table can still contain additional user-created fields.

## Markdown Format

Messages are written below the configured content folder using a stable, collision-resistant filename:

```text
Mail/2026/07/2026-07-22-103000-project-update-a1b2c3.md
```

The document begins with a compact GFM metadata table:

```markdown
| Field | Details |
| --- | --- |
| **From** | sender@example.com |
| **To** | recipient@example.com |
| **Received** | 2026-07-22T02:30:00Z |
| **Message ID** | example-message-id |

---

Converted email content.
```

Remote HTML must be sanitized before Markdown conversion. Tracking pixels, scripts, remote CSS, and executable attachments are never rendered automatically.

For `multipart/alternative` messages, the runtime must prefer the sanitized HTML
part because it carries the sender's headings, links, lists, and semantic tables.
The plain-text part is a fallback only when the HTML part is absent or produces no
readable content. Conversion must use ATX headings (`#`, `##`, and so on). In
plain-text fallback content, underline-style sections are promoted to ATX
headings and standalone decorative rules are removed so they cannot be
misinterpreted as document structure.

Layout tables are flattened into readable sections. Genuine data tables are
preserved as GFM tables when their cells can be represented safely. Hidden
preheader text, scripts, styles, forms, event handlers, and remote images are
removed before conversion.

## Cursor And Deduplication

The primary identity is:

```text
workflow_id + mailbox + UIDVALIDITY + UID
```

`Message-ID` is stored for diagnostics and cross-folder matching but cannot be the only deduplication key because it may be missing or duplicated.

The runtime commits the cursor only after the Markdown file and table row are both durable. Retrying an interrupted sync must update the existing row instead of creating a duplicate.

## Error Handling

- Authentication errors pause scheduled sync until the connection is fixed.
- A changed `UIDVALIDITY` starts a controlled mailbox rescan with deduplication.
- Individual malformed messages are recorded as failed items without aborting the remaining batch.
- Attachment failures do not discard the message body; the table row records an error detail.
- Deleting a sync workflow never deletes imported Markdown, attachments, or table rows.

## Delivery Phases

### Phase 1: Public client and contract

- Add the public schema and typed client API.
- Add capability-gated inbox sync management under Connections.
- Add create, edit, delete, test, enable, and Sync now interactions.
- Make Document fields open workspace Markdown.
- Add client mocks, unit tests, and browser E2E coverage.

### Phase 2: Private runtime

- Implement the contract in the private runtime repository.
- Store passwords in the runtime secret store.
- Implement IMAP test, fetch, parsing, cursor, deduplication, scheduling, Markdown creation, attachments, and table upsert.
- Advertise the `email_sync` capability only after every endpoint is available.

### Phase 3: Black-box integration

- Run the public client against a local private runtime binary.
- Validate first sync, incremental sync, restart recovery, credential failure, UIDVALIDITY changes, attachments, duplicate prevention, and document navigation.
- Add Gmail API and Microsoft Graph connectors only after the IMAP behavior is stable.
