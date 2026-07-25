## Summary

Describe the user-visible change and why it is useful.

## Screenshots

- Add screenshots or a screen recording for changed UI behavior.
- If there is no visual change, write `No visual change`.

## Verification

- [ ] Focused unit or component tests
- [ ] `pnpm run build:check`
- [ ] `pnpm test:e2e`
- [ ] `pnpm test:table:e2e`
- [ ] Added or updated a regression test, or explained why one was not needed

List the exact commands that were run and note any platform-specific coverage.

## AI Review

If an AI coding agent contributed, summarize its review of:

- user-visible behavior and copy accuracy;
- macOS, Windows, web-preview, and Electron differences;
- public runtime contracts, mocks, and private runtime boundaries;
- performance and accessibility risks;
- English-only content, branding, and portable paths.

If no AI coding agent contributed, write `Not applicable`.

## Security Review

Summarize the applicable input, path, credential, account, network, dependency,
update, IPC, external URL, and destructive-action risks reviewed.

## Release Boundary

- [ ] No credentials, private runtime binaries, host-specific paths, generated local data, or private implementation details are included.
- [ ] Public contracts or mocks were updated before relying on new runtime behavior.
- [ ] This pull request does not include an unrequested version bump, tag, or release action.
