# Commercialization Experience Remediation Plan

## Objective

Make the first commercial Kition experience trustworthy and easy to complete:

1. A new user understands the available AI options.
2. A user can sign in and complete the first hosted AI request without getting stuck.
3. Account, plan, credit, billing, update, support, and privacy states are accurate.
4. The product can measure activation and conversion without weakening its data-ownership guarantees.

The private `kition-console` implementation remains outside this repository. The public client depends only on explicit account, entitlement, credit, billing, and authentication contracts.

## Success Metrics

The implementation should make these metrics measurable:

- fresh install to workspace opened;
- workspace opened to first AI attempt;
- first AI attempt to sign-in started;
- sign-in started to sign-in completed;
- sign-in completed to first successful hosted AI response;
- first successful document, Kitable, and Workflow action;
- trial started to paid conversion;
- credits-low and credits-exhausted to billing opened;
- billing opened to credits or subscription refreshed;
- D1 and D7 return rate;
- startup, update, sign-in, and Agent failure rate.

The primary activation metric is **first successful AI response or deterministic Workflow run**, not account creation by itself.

## Product State Model

Introduce one client-owned account readiness model instead of inferring readiness from the selected model:

```text
loading
signed_out
connecting
ready
expired
credits_low
credits_empty
temporary_error
```

Hosted model availability should be derived from both model configuration and account readiness:

```text
needs_model_configuration
needs_account_sign_in
ready
credits_low
credits_empty
temporarily_unavailable
```

Internal API and storage names may remain compatible during the first implementation. User-facing copy must use **Kition Account** and **Kition Cloud**, not Console, Portal, session, token, or bootstrap terminology.

## Delivery Sequence

### PR 1: Hosted AI Activation And Update Trust

**Priority:** P0  
**Risk:** Medium  
**Goal:** A signed-out user cannot mistake a hosted model for a ready model, and can sign in from the exact point of failure.

Implementation:

- Add a shared Kition account state hook/service backed by the existing secure account session.
- Make hosted model readiness depend on the account state.
- Replace the signed-out Agent suggestion grid with a clear `Sign in to use Kition AI` action.
- When a signed-out user presses Send, preserve the draft, open sign-in, and resume the request after successful authentication.
- Keep BYO providers usable without a Kition account.
- Add explicit expired-session and temporary-restore-failure actions.
- Remove misleading hosted-provider green status, `Auto` session state, and `Disconnect` action while signed out.
- Fix release-note links to use `https://github.com/KitionAI/kition/releases/tag/<tag>`.
- Replace user-facing Console and Portal wording on the Agent, model settings, credit errors, and account surfaces.

Likely public-client ownership:

- `src/services/portalAccount.ts`
- `src/features/agent/hooks/useWorkspaceAgent.ts`
- `src/features/agent/components/AgentChatPanel.tsx`
- `src/features/settings/AiModelsPane.tsx`
- `src/features/workspace/components/WorkspaceScreen.tsx`
- `src/features/updates/UpdateBanner.tsx`
- account and settings locale files

Acceptance criteria:

- A fresh signed-out profile never displays Kition Cloud as ready.
- Clicking a hosted Agent suggestion while signed out opens the sign-in flow.
- The original prompt is still present after canceling sign-in.
- The original prompt runs once, and only once, after successful sign-in.
- Expired credentials produce a sign-in action rather than a generic error toast.
- OpenAI, Anthropic, DeepSeek, and custom providers continue to work without Kition sign-in.
- View release notes opens the release in the public Kition repository.

Required tests:

- account readiness unit tests;
- Agent signed-out, canceled, successful, expired, and retry component tests;
- model settings truthful-status tests;
- update release URL test;
- renderer e2e for sign-in and resumed send;
- Electron e2e with isolated secure storage.

### PR 2: Commercial Account And Billing Surface

**Priority:** P0  
**Risk:** Medium  
**Goal:** The account surface explains value, current entitlement, and the next commercial action.

Implementation:

- Redesign the account dialog around Kition Account rather than authentication internals.
- Show email, plan name, subscription state, available credits, reset time, and billing state.
- Remove token prefix and raw token expiry from the normal user view.
- Add `Manage plan`, `Top up credits`, and `Sign out` actions.
- Show the benefit of signing in before authentication: hosted models, no API key, credit visibility, and account recovery.
- Distinguish recurring plan credits from purchased wallet credits when both are available.
- Refresh account and credit state after returning from billing.
- Add low-credit and exhausted-credit states with one consistent billing destination.
- Add Terms, Privacy, and Support links.

Private contract dependencies:

- stable plan display name or plan code mapping;
- subscription state enum;
- credit totals, balances, and reset timestamp;
- billing management URL;
- top-up URL;
- Terms, Privacy, and Support URLs;
- optional trial state and trial expiration timestamp.

The private service should return URLs or documented relative routes. The public client must not hardcode private deployment hosts beyond the configured Portal base URL.

Acceptance criteria:

- Signed-out, connecting, ready, trial, paid, canceled, credits-low, credits-empty, and temporary-error states are visually distinct.
- Every blocked commercial state has exactly one primary recovery action.
- Account state refreshes after billing without restarting the app.
- No token, access token, refresh token, or internal session identifier is displayed.
- Billing actions are unavailable when the server does not provide a valid destination.

Required tests:

- normalized account contract tests;
- account dialog component tests for every state;
- external URL allowlist tests;
- billing-return refresh test;
- credit exhaustion and top-up e2e.

### PR 3: First-Run Activation Experience

**Priority:** P1  
**Risk:** High  
**Goal:** Replace the large sample dump with a short path to first value.

Implementation:

- Add a first-run activation panel with three steps:
  1. choose or confirm a workspace;
  2. choose `Kition Cloud`, `Bring your own API key`, or `Local-only`;
  3. complete one guided Agent or deterministic Workflow action.
- Preserve the user's data-location choice and explain what leaves the device before sign-in or provider configuration.
- Seed the complete onboarding workspace with tables and functional guides.
- Group product guides under `Getting Started/Guides` so the first-run tree stays compact.
- Shorten the Welcome document to one screen and link to deeper examples.
- Record completion per vault and allow reopening the guide.
- Keep the product fully usable when onboarding is skipped.
- Select onboarding content and copy from the active locale.

Suggested first success paths:

- hosted/BYO AI: summarize the Welcome document and write the result into the page;
- local-only: run a deterministic Contacts or Expenses Workflow;
- Kitable-focused: add and edit one record, then switch view;
- document-focused: create, edit, and save a Markdown document.

Acceptance criteria:

- A new user sees no more than three onboarding decisions before entering the workspace.
- The first success path can be completed in under three minutes without documentation.
- Skipping onboarding does not create repeated prompts.
- Full demos are available but are not imported automatically.
- Existing vaults are not modified or re-seeded.

Required tests:

- migration and per-vault completion tests;
- empty and existing vault tests;
- each provider-choice path;
- skip and reopen behavior;
- narrow viewport and dark/light theme screenshots;
- first-run renderer and Electron e2e.

### PR 4: Support, Diagnostics, And Trust

**Priority:** P1  
**Risk:** Low  
**Goal:** Paid users can get help without understanding GitHub or runtime internals.

Implementation:

- Add `Send feedback`, `Contact support`, and `Copy diagnostics` to About.
- Keep `Report an issue on GitHub` as a contributor-oriented secondary action.
- Generate a redacted diagnostic summary containing app version, build identity, platform, runtime protocol, account state category, update state, and support ID.
- Never include document contents, prompts, tokens, API keys, workspace paths, or browser history by default.
- Add Privacy Policy and Terms of Service links.
- Add a clear offline and network troubleshooting path.
- Reuse structured startup and update diagnostics instead of exposing raw stack traces.

Acceptance criteria:

- A user can copy a useful redacted diagnostic report in one click.
- Sensitive values are covered by automated redaction tests.
- Support actions work when the private service is temporarily unavailable.
- User-facing errors contain a next action when recovery is possible.

Required tests:

- redaction unit tests;
- support URL validation tests;
- startup, account, network, and update diagnostic component tests;
- copy-to-clipboard e2e.

### PR 5: Privacy-Respecting Product Analytics

**Priority:** P1  
**Risk:** High  
**Goal:** Measure activation, retention, reliability, and conversion without collecting workspace content.

Implementation:

- Write a public analytics event contract before adding transport.
- Track event names, timestamps, build identity, app version, platform, anonymous installation ID, and coarse result categories.
- Never collect document names, paths, contents, prompts, model responses, API keys, tokens, URLs, or browser history.
- Add a clear analytics preference and privacy disclosure.
- Queue events locally and fail open when offline.
- Separate product events from crash diagnostics.
- Add event-schema validation and a development event inspector.

Minimum event set:

```text
app_started
workspace_opened
onboarding_started
onboarding_completed
provider_choice_selected
account_sign_in_started
account_sign_in_completed
account_sign_in_failed
agent_first_request_started
agent_first_request_completed
workflow_first_run_completed
credits_low_seen
credits_exhausted_seen
billing_opened
update_check_completed
update_install_completed
support_opened
```

Acceptance criteria:

- Event payloads pass schema validation and sensitive-data rejection tests.
- Disabling analytics stops transport immediately.
- Offline analytics never blocks product workflows.
- Commercial dashboards can compute the success metrics listed in this plan.

### PR 6: Settings Information Architecture

**Priority:** P1  
**Risk:** Medium  
**Goal:** Keep common commercial actions visible and move technical configuration out of the primary path.

Proposed primary navigation:

```text
General
Account
AI Models
Connections
Display
Notifications
Advanced
About
```

Move these sections under Advanced:

- MCP Servers;
- Network;
- Local data and runtime paths;
- Hooks;
- debug mode;
- advanced provider wire settings.

Implementation:

- Add Account as a first-class settings section or deep-link to the account dialog.
- Preserve searchable access to every advanced setting.
- Keep direct deep links compatible with existing settings URLs.
- Add an Advanced disclosure instead of removing expert features.
- Review visual focus, active, hover, and selected states so only one navigation item reads as selected.

Acceptance criteria:

- Common users can find account, AI, appearance, and update settings without seeing runtime internals.
- Existing deep links and saved settings continue to work.
- Search returns advanced settings and reveals their parent section.
- Keyboard focus and selected state are visually distinct.

## Localization Decision

The current client ships English, Spanish, French, Portuguese, and Russian UI resources while the onboarding document is always English. Before adding another market:

- choose the initial commercial regions;
- define the source of truth for localized legal and billing copy;
- make onboarding content follow the active locale;
- add localization coverage checks for all new account and billing strings.

Chinese localization should be treated as a market decision and implemented through the repository's approved localization mechanism without weakening the tracked-content guard.

## Commercial And Open-Source Boundary

- Keep the desktop client, account contract, mocks, and black-box tests public.
- Keep billing implementation, account service internals, credit ledger, and hosted model routing private.
- Do not make public tests depend on private services or production credentials.
- Provide deterministic mock states for signed out, trial, paid, expired, credits low, credits empty, and temporary service failure.
- Derive dev, rc, and stable behavior from the existing build identity; do not add local production toggles.
- Keep BYO provider and local-only workflows usable without a commercial account.

## Release Gates

Every PR in this plan must pass:

```bash
pnpm check
pnpm test:e2e
pnpm test:table:e2e
```

Electron-specific changes must also pass:

```bash
pnpm test:desktop:e2e
```

Release candidates must additionally verify:

- fresh profile onboarding;
- sign-in cancel, success, expiry, and retry;
- first hosted Agent request;
- low and exhausted credits;
- billing return and account refresh;
- update check, download, and release-note URL;
- proxy, offline, and temporary network failure;
- no writes to the real user profile during automated tests.

## Recommended First Milestone

Ship PR 1 and PR 2 together as the first commercial activation milestone. Do not start paid acquisition or invite a broad beta cohort until:

- hosted AI readiness is truthful;
- sign-in can be completed from the Agent surface;
- the first prompt resumes after sign-in;
- plan and credit state are visible;
- billing and support actions exist;
- release notes and auto-update use the public release repository.
