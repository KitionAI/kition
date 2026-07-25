# Kition Development Standard

This document defines how Kition changes should be scoped, implemented,
reviewed, and verified. It applies whether the work is done manually, with an
AI coding agent, or inside Orca.

## Principles

1. **Solve one user problem at a time.** Keep a branch or worktree focused on a
   single feature, fix, refactor, or documentation outcome.
2. **Preserve local ownership.** Workspace files, credentials, and runtime
   boundaries are product contracts, not implementation details to work around.
3. **Make claims from real state.** UI copy, documentation, and tests must not
   imply that Kition completed, verified, protected, or observed something
   unless the code has the result data to support that claim.
4. **Test user-visible behavior.** Use unit tests for pure logic and component
   behavior. Use end-to-end tests when the regression depends on routing,
   Electron, browser events, persistence, IPC, or a real rendered interaction.
5. **Leave evidence.** A pull request should make it easy to understand the
   user-visible change, the risks reviewed, and the commands that passed.

## Required Reading

Read the files that own the affected surface before editing:

- `AGENTS.md` for repository-wide identity, privacy, runtime, and completion
  rules.
- `docs/design.md` and `docs/product-ui-style.md` for UI or visual work.
- `docs/kition-ui-development.md` for frontend ownership and file placement.
- `contracts/runtime/` before changing client/runtime behavior.
- `docs/runtime-development.md` for runtime selection and local integration.
- `.github/SECURITY.md` before handling credentials, authentication, updates,
  or private reports.

## Branch And Worktree Scope

Use a descriptive branch name:

- `feat/<short-outcome>`
- `fix/<short-outcome>`
- `docs/<short-outcome>`
- `refactor/<short-outcome>`
- `test/<short-outcome>`

Rules:

- Create one branch and one worktree for one task.
- Do not develop a feature directly on `main`.
- Do not let two agents write to the same worktree at the same time.
- Parallel work is acceptable only when the tasks are independent and use
  separate branches and worktrees.
- Preserve unrelated local changes. Never reset, overwrite, or reformat files
  outside the task to make a diff look cleaner.
- Resolve conflicts in the worktree that owns the change, then rerun the
  relevant verification commands.

## Recommended Orca Workflow

Orca is optional, but its worktree model fits Kition well.

1. Open the Kition repository in Orca.
2. Create a dedicated worktree from the current `main` branch.
3. Name the worktree after the user-visible outcome, not the implementation
   technique.
4. Keep one terminal for the development server and one for focused tests.
5. Give the coding agent the task contract below and require it to read
   `AGENTS.md` before editing.
6. Review the diff in Orca before accepting generated changes. For visual work,
   inspect the rendered UI and attach a screenshot or recording to the pull
   request.
7. Run the completion gates in the same worktree before opening the pull
   request.

### Agent task contract

Use this template when starting an Orca agent session:

```text
Outcome:
Describe the user-visible result in one or two sentences.

In scope:
- List the Kition surfaces, files, or public contracts that may change.

Out of scope:
- List adjacent behavior that must remain unchanged.

Constraints:
- Read and follow AGENTS.md.
- Preserve unrelated worktree changes.
- Keep all tracked text and filenames in English.
- Do not cross the public client/runtime boundary.
- Add a regression test for changed behavior.

Verification:
- List focused tests for the affected surface.
- Run pnpm run build:check for UI or TypeScript changes.
- Run python3 scripts/check-i18n.py.
- Run pnpm test:table:e2e before completion.
```

## Implementation Rules

### Public client boundary

- This repository owns the React/Electron client, public contracts, mocks,
  fixtures, packaging, and black-box tests.
- Do not recreate runtime implementation details or a source fallback here.
- For runtime behavior changes, update the public contract and mock first.
- Validate private runtime integration only through an explicit runtime binary
  and public HTTP/capability behavior.

### Frontend structure

- Put shell, routing, and bootstrap glue in `src/app`.
- Put reusable controls in `src/components`.
- Put business UI and behavior in `src/features/<domain>`.
- Prefer shared tokens and primitives over page-local CSS overrides.
- Split a file before adding more behavior when it is already near the size
  limits described in `docs/kition-ui-development.md`.
- Remove dead wrappers, imports, and duplicated helpers created by the change.

### Desktop and portability

- Support macOS and Windows behavior for desktop changes.
- Use path utilities and portable placeholders; never hardcode host paths.
- Treat browser, filesystem, notification, credential, update, and IPC code as
  trust boundaries.
- Keep web-preview behavior useful when the private runtime is unavailable.

### Tests

- Add a focused test that fails for the original regression.
- Prefer pure unit tests for transforms, state machines, and formatting.
- Prefer component tests for visible states and user actions.
- Use end-to-end tests for real keyboard, pointer, editor, routing, persistence,
  Electron, or IPC behavior.
- End-to-end assertions should target what the user can see or do, not only an
  internal store value.
- Keep mocks aligned with public runtime contracts.

## Verification Matrix

Run the smallest useful checks while iterating, then the required completion
gates.

| Change | Focused verification |
| --- | --- |
| Documentation only | Link review, `python3 scripts/check-i18n.py`, branding check |
| React component or hook | Focused Vitest file, `pnpm run build:check` |
| Shared UI or layout | Focused tests, `pnpm run build:check`, visual review |
| Table behavior | Focused tests, `pnpm test:kitable:e2e`, required table widget gate |
| Workflow or scenario | Focused tests and the matching inspection command |
| Electron or packaging | `pnpm test:desktop:unit` and relevant Electron E2E |
| Runtime contract | Contract/mock tests plus black-box integration with an explicit binary |

Before completion, always run:

```bash
python3 scripts/check-i18n.py
pnpm test:table:e2e
```

For normal code changes, also run:

```bash
pnpm check
pnpm test:e2e
```

If a full command is temporarily impractical, the pull request must state what
was not run and why. The mandatory repository completion gates may not be
silently skipped.

## Review Checklist

Every change should be reviewed for the applicable risks:

- user-visible behavior and copy accuracy;
- macOS and Windows differences;
- web preview versus Electron behavior;
- local workspace paths and portable path handling;
- public runtime contract and mock compatibility;
- credentials, account state, network requests, IPC, and external URLs;
- destructive actions, confirmation, and recovery behavior;
- performance in editor, table, browser, and streaming hot paths;
- accessibility, keyboard navigation, focus, and narrow desktop windows;
- English-only tracked content, branding, and host privacy.

## Pull Request Evidence

A pull request should contain:

1. A concise summary of the user-visible change.
2. Screenshots or a recording for visual changes, or `No visual change`.
3. The exact focused and completion commands that passed.
4. An AI review summary when an AI coding agent contributed to the change.
5. A basic security review covering relevant input, path, credential, network,
   dependency, update, IPC, and external-action risks.
6. Runtime-boundary notes when public contracts, mocks, capability flags, or
   private integration behavior are involved.

Maintainers own version bumps, tags, signing, packaging credentials, and
release publication. Normal contributions must not perform release actions.
