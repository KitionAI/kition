# Portable Workspace Storage Plan

## Objective

A Kition workspace must be a complete portable unit. Copying or cloning the
workspace directory must restore all workspace-owned content without depending
on an application data directory from the original machine.

Credentials, OAuth tokens, account sessions, logs, caches, and device-specific
preferences are intentionally excluded. Workspace files may store secret
references, but never secret values.

## Current Boundary

- Markdown documents and `.kitable` files are already workspace-addressed.
- Document image persistence can write into the workspace.
- Table attachments are represented by URLs such as `/uploads/...`, which are
  not portable when the upload directory is outside the workspace.
- Some workspace metadata is browser-local rather than workspace-owned.
- Runtime identity currently needs a stable workspace manifest identity before
  a workspace can move to another filesystem path without changing identity.

## Target Layout

```text
<workspace>/
  .kition/
    workspace.json
    metadata.json
    assets/sha256/<prefix>/<content-hash>.<extension>
    workflows/<workflow-id>/definition.json
    workflows/<workflow-id>/runs/<run-id>.jsonl
    agents/<session-id>/session.json
    agents/<session-id>/messages.jsonl
    agents/<session-id>/events.jsonl
    sync/email/
    sync/forms/
    journal/
  Documents/
  Tables/
  *.md
  *.kitable
```

All persisted paths are workspace-relative. Absolute paths, hostnames,
localhost URLs, `file:` URLs, blob URLs, and `/uploads/...` URLs are invalid as
authoritative references.

## Public Contract

The public behavior is defined by
`contracts/runtime/workspace-storage.schema.json` and the runtime capability
`workspace_portable_storage_v1`.

The client must not use the new storage endpoints until that capability is
present. The public endpoints cover status, inventory, verification, and
migration. Private runtime implementation remains outside this repository.

## Delivery Phases

1. Add the public schema, client types, capability gate, and read-only storage
   health API.
2. Make workspace assets content-addressed and return portable attachment
   metadata while preserving resolved URLs for display compatibility.
3. Migrate legacy upload URLs and inline assets with hash verification and
   atomic reference updates.
4. Move workspace-owned metadata, workflows, Agent history, and sync state into
   workspace-owned canonical files. Rebuildable indexes may remain local.
5. Add Git preparation, storage health UI, repair actions, and optional Git LFS
   recommendations for binary files.

## Implemented Runtime Behavior

- New table uploads and AI-generated images are written to the content-addressed
  workspace asset directory and carry `assetId`, `sha256`, and `workspacePath`
  metadata.
- The runtime reads both portable workspace assets and legacy `/uploads/...`
  references during the compatibility window.
- A stable `.kition/workspace.json` identity survives directory moves and Git
  clones.
- Agent sessions, messages, events, tool calls, artifacts, plans, goals, and
  subagent state are mirrored under `.kition/agents/` and restored at startup.
- Form and email sync definitions, cursors, items, and run state are mirrored
  under `.kition/sync/` and restored at startup. Passwords, tokens, and email
  secret payloads are excluded and must be reconnected on a new device.
- The storage endpoints inventory files, verify content hashes, detect legacy
  and external references, and migrate Markdown and `.kitable` attachment
  references with dry-run support.

## Migration Guarantees

- Migration is idempotent, restartable, and supports a dry run.
- Assets become durable before references are changed.
- Size and SHA-256 are verified before the migration is committed.
- Failed migrations leave the previous storage readable.
- Legacy storage remains read-only for one compatibility window after a
  successful migration.

## Acceptance Tests

- Upload images and attachments, move the workspace, and reopen them.
- Remove the original application data and upload directories, then reopen the
  workspace without missing data.
- Commit the workspace, clone it to another directory, and compare inventory
  hashes.
- Restart during asset migration and recover without broken references.
- Detect missing, corrupted, orphaned, external, and legacy assets.
- Confirm that no workspace-owned persisted record contains a real absolute
  host path or secret value.

Git provides complete backup and restoration in the first release. Concurrent
line-level merging of `.kitable` files and binary assets is a separate problem
and is not guaranteed by this storage contract.
