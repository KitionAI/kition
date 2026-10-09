# Kit Protocol, Version 1

Status: draft, 2026-10-09.

The Kit Protocol connects Kition to kits: native executables that open and edit
one family of documents. Architecture and rationale are in
[kit-platform-architecture.md](kit-platform-architecture.md).

Machine-readable contracts:

| File | Purpose |
| --- | --- |
| [`contracts/kit/kit-manifest.schema.json`](../contracts/kit/kit-manifest.schema.json) | `kit.json` shipped inside every kit package |
| [`contracts/kit/kit-index.schema.json`](../contracts/kit/kit-index.schema.json) | Signed index of published kits and their assets |
| [`contracts/kit/kit-protocol.schema.json`](../contracts/kit/kit-protocol.schema.json) | Parameter and result shapes for every method below |

When this document and the schemas disagree, the schemas win and this document
is fixed.

## 1. Roles

| Role | Who | Count per kit process | May use |
| --- | --- | --- | --- |
| `host` | Kition desktop (Tauri shell) | Exactly one, connects first | Everything |
| `agent` | Kition runtime | Zero or more | `kit.*` except `kit.shutdown`, `document.*`, `commands.*`, `view.*` |

The kit is the server. Clients connect to it.

## 2. Transport

- JSON-RPC 2.0 messages, UTF-8, one message per line (newline-delimited JSON).
  A message must not contain a raw newline.
- Endpoint: a Unix domain socket on macOS and Linux, a named pipe on Windows.
  The host chooses the endpoint path inside a per-user directory with mode
  `0700` (or an equivalent Windows ACL).
- Maximum message size is 64 MiB. Large binary payloads (screenshots, exports)
  should be written to files rather than inlined whenever a URI is acceptable.

## 3. Launch

The host starts the kit executable with one argument and four environment
variables:

```text
<kit-executable> --kition-kit

KITION_KIT_PROTOCOL=1
KITION_KIT_ENDPOINT=<socket path or pipe name>
KITION_KIT_TOKEN=<64 hex characters, random per launch>
KITION_KIT_SURFACE=embedded | window | headless
```

The token is passed through the environment, never on the command line, so
that it does not appear in process listings.

When the endpoint is listening, the kit writes exactly one line to standard
output and then never writes to standard output again:

```json
{"type":"ready","protocolVersion":1}
```

Standard error is free-form diagnostic logging. The host must reach `ready`
within 10 seconds or it terminates the process.

## 4. Lifecycle

```text
host                          kit
 | -- spawn ------------------> |
 | <------------- ready line -- |
 | -- kit.initialize ---------> |   role=host, token, preferences
 | <----------- capabilities -- |
 | -- kit.initialized (notif) ->|
 | -- surface.attach ---------> |   embedded only
 | -- document.open ----------> |
 |          ... session ...     |
 | -- kit.shutdown -----------> |   kit flushes and exits within 5 s
```

### `kit.initialize` (request, every client)

The first message on every connection. Any other method before it fails with
`-32002 not_initialized`. A wrong token closes the connection after a
`-32001 unauthorized` error. The first connection must use role `host`; agent
connections are rejected until the host has initialized.

Parameters:

| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | integer | `1` |
| `token` | string | Value of `KITION_KIT_TOKEN` |
| `role` | `host` or `agent` | |
| `client` | `{ name, version }` | |
| `locale` | string | BCP 47, for example `en-US` or `zh-CN` (host only) |
| `appearance` | `light` or `dark` | Host only |
| `reservedShortcuts` | array of shortcut | Host only; see section 8 |
| `workspaceRoots` | array of `file://` URIs | Host only; agent `document.open` calls must stay inside these roots |

Result:

| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | integer | Must equal the requested version |
| `kit` | `{ id, version }` | Must match the installed manifest |
| `capabilities` | object | Surfaces, embedding mechanisms, document formats, optional methods |

A version mismatch fails with `-32004 unsupported_protocol`.

### `kit.initialized` (notification, client to kit)

Sent once after a successful `kit.initialize`.

### `kit.ping` (request)

Returns `{}`. The host pings every 15 seconds; three consecutive failures mean
the kit is hung and the host restarts it.

### `kit.setPreferences` (request, host)

Updates `locale` and `appearance` while running.

### `kit.shutdown` (request, host)

The kit stops accepting new requests, closes documents without saving, returns
`{}`, and exits within 5 seconds. The host saves or prompts before calling it.

### `$/cancelRequest` (notification, client to kit)

`{ id }` cancels an in-flight request; the request then fails with
`-32800 request_cancelled`.

## 5. Documents

A kit may hold several open documents. Documents are identified by an opaque
`documentId` assigned by the kit.

URIs are absolute `file://` URIs in version 1. A kit reads and writes only URIs
it received from a client through `document.open`, `document.saveAs`, or
`document.export`, plus its own private cache directory.

| Method | Direction | Parameters | Result |
| --- | --- | --- | --- |
| `document.open` | request | `uri`, optional `readOnly`, optional `create: { format }` | `DocumentState` |
| `document.list` | request | none | `{ documents: DocumentState[] }` |
| `document.activate` | request, host | `documentId` | `{}`; selects the document shown in the surface |
| `document.save` | request | `documentId` | `{ uri }` |
| `document.saveAs` | request | `documentId`, `uri`, optional `format` | `{ uri }` |
| `document.export` | request | `documentId`, `uri`, `format`, optional `options` | `{ uri }` |
| `document.close` | request | `documentId`, optional `discardChanges` | `{}`; fails with `-32011 document_dirty` if dirty and not discarding |
| `document.didChangeOnDisk` | notification, host to kit | `documentId` | The kit reloads or reports a conflict |
| `document.didChangeState` | notification, kit to all clients | `DocumentState` | Sent on dirty, title, undo, or redo changes |
| `document.didSave` | notification, kit to all clients | `documentId`, `uri` | |

`DocumentState` is `{ documentId, uri, title, format, readOnly, dirty, canUndo, canRedo }`.

Opening the same URI twice returns the existing `documentId`.

## 6. Commands

Commands are the single way to change a document. Every UI action in a kit
maps to a command, so agents and people have the same abilities.

### `commands.list` (request)

Parameters: optional `documentId`, optional `groups` (array of tool group ids
from the manifest).

Result: `{ commands: CommandInfo[] }` where `CommandInfo` is:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable dotted identifier, for example `layer.newAdjustmentLayer.curves` |
| `title` | string | Localized to the host locale |
| `description` | string | Optional; written for agents |
| `group` | string | A tool group id declared in the manifest |
| `params` | JSON Schema object | Parameters accepted by `commands.execute` |
| `mutates` | boolean | `true` if it changes the document |
| `enabled` | boolean | For the given document and current selection |

### `commands.execute` (request)

Parameters: `documentId`, `command`, `params`, `origin` (`user` or `agent`).

Result: `{ changed, result }`, where `result` is optional command-specific JSON.

Errors: `-32020 command_not_found`, `-32021 command_disabled`,
`-32022 invalid_params`.

Every executed command that mutates a document is one undo step.

### `commands.didChangeEnabled` (notification, kit to all clients)

`{ documentId, enabled: string[], disabled: string[] }`, sent when enablement
changes. Clients that do not care may ignore it.

## 7. View

| Method | Parameters | Result |
| --- | --- | --- |
| `view.screenshot` | `documentId`, `scope` (`canvas` or `surface`), optional `maxSize` | `Image` |
| `view.describe` | `documentId` | `{ summary, state }`: a short text summary and kit-defined structured state, for example layers, pages, or timeline tracks |

`Image` is `{ mimeType: "image/png", width, height, data }` with base64 `data`.
`view.screenshot` must work in `headless` mode by rendering offscreen.

## 8. Surface (Host Only)

Only valid when `KITION_KIT_SURFACE` is `embedded` or `window`.

| Method | Parameters | Result |
| --- | --- | --- |
| `surface.attach` | `mechanism`, `parent`, `bounds`, `scaleFactor`, `visible` | `{}` |
| `surface.setBounds` | `bounds`, `scaleFactor` | `{}` |
| `surface.setVisible` | `visible` | `{}` |
| `surface.focus` | none | `{}` |
| `surface.snapshot` | none | `Image` of the full surface |
| `surface.detach` | none | `{}`; the kit keeps documents open with no visible surface |

`bounds` is `{ x, y, width, height }` in logical pixels, relative to the
top-left of the host window content area. `scaleFactor` is the device pixel
ratio.

`mechanism` and `parent`:

| Mechanism | Platforms | `parent.handle` |
| --- | --- | --- |
| `child-window` | Windows, Linux X11 | Host top-level `HWND` or X11 window id, as a decimal string |
| `overlay-window` | macOS | Host `NSWindow` window number, as a decimal string |
| `shared-texture` | macOS | Reserved; parameters are defined by the embedding prototype |
| `top-level` | all | Absent; the kit opens its own window (`window` surface) |

A kit that does not support the requested mechanism fails with
`-32030 surface_mechanism_unsupported`; the host then falls back to
`top-level`.

During a window drag or resize the host sends `surface.setBounds` for every
change. Kits must apply the latest bounds and may drop stale ones.

### Focus and input notifications (kit to host)

| Notification | Parameters | Meaning |
| --- | --- | --- |
| `surface.didFocus` | none | The surface received keyboard focus |
| `surface.didBlur` | none | The surface lost keyboard focus |
| `input.forwardShortcut` | `Shortcut` | A reserved shortcut was pressed while the surface had focus |
| `surface.didRequestFocusExit` | `direction` (`next` or `previous`) | Tab navigation left the surface |

`Shortcut` is `{ key, code, modifiers }`, with `modifiers` drawn from `alt`,
`ctrl`, `meta`, and `shift`. The kit must never act on a reserved shortcut.

## 9. Progress And Logs (Kit To All Clients)

| Notification | Parameters |
| --- | --- |
| `kit.progress` | `{ token, title, fraction?, done }`; `token` is the related request id |
| `kit.log` | `{ level: "debug" or "info" or "warn" or "error", message }` |

Log messages must not include document contents, file paths outside granted
URIs, or credentials.

## 10. Errors

Standard JSON-RPC errors (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`)
keep their meaning. Kit errors carry a stable string `data.reason`:

| Code | `data.reason` | Meaning |
| --- | --- | --- |
| -32001 | `unauthorized` | Wrong token |
| -32002 | `not_initialized` | Method called before `kit.initialize` |
| -32003 | `role_forbidden` | Method not allowed for the client role |
| -32004 | `unsupported_protocol` | Protocol version mismatch |
| -32010 | `document_not_found` | Unknown `documentId` |
| -32011 | `document_dirty` | Close without `discardChanges` on a dirty document |
| -32012 | `unsupported_format` | Format cannot be opened, saved, or exported |
| -32013 | `io_error` | Read or write failed; `data.detail` is a sanitized message |
| -32014 | `uri_not_granted` | URI outside `workspaceRoots` or never granted |
| -32020 | `command_not_found` | Unknown command id |
| -32021 | `command_disabled` | Command not enabled in the current state |
| -32022 | `invalid_params` | Command parameters failed schema validation; `data.errors` lists them |
| -32030 | `surface_mechanism_unsupported` | Requested embedding mechanism is not available |
| -32031 | `surface_not_attached` | Surface method without an attached surface |
| -32800 | `request_cancelled` | Cancelled by `$/cancelRequest` |

## 11. Timeouts

| Operation | Limit |
| --- | --- |
| Launch to `ready` | 10 s |
| `kit.initialize` | 10 s |
| `kit.shutdown` to process exit | 5 s, then the host kills the process |
| Other requests | 30 s, except `document.*` and `commands.execute`, which report `kit.progress` and have no fixed limit |

## 12. Versioning

- `protocolVersion` is an integer. Breaking changes increment it; the host may
  support several versions at once.
- Additive features within a version are discovered through
  `capabilities`, never through kit version comparisons.
- Clients must ignore unknown notification methods and unknown result fields.

## 13. Mapping From Upstream Control Channels

Upstream engines already expose a JSON-lines control channel. The kit adapter
translates it:

| Upstream concept | Kit Protocol |
| --- | --- |
| Engine command registry listing | `commands.list` |
| `engine.execute` | `commands.execute` |
| `ui.screenshot` / offscreen render | `view.screenshot`, `surface.snapshot` |
| MCP server tools | Not used directly; the Kition runtime builds agent tools from `commands.list` |

## 14. Conformance Suite

Every kit must pass a shared black-box suite before release:

1. Launch, `ready` line, and initialize within the time limits.
2. Wrong token, wrong protocol version, and pre-initialize calls are rejected.
3. Agent role cannot call surface methods or `kit.shutdown`.
4. Open, edit by command, save, reopen, and compare a fixture document.
5. `uri_not_granted` for agent URIs outside `workspaceRoots`.
6. Every listed command has a valid JSON Schema for `params`.
7. `view.screenshot` works in `headless` mode.
8. `kit.shutdown` exits within 5 seconds.
9. The kit does not write to standard output after the `ready` line.

Embedding behavior (section 8) is accepted manually in the real desktop client
on each platform; automated headless runs cannot exercise it.
