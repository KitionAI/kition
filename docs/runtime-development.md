# Runtime Development

The Kition runtime is the Rust workspace under `crates/`. The desktop shell in
`src-tauri/` links `kition-api` and runs it inside the app process: the runtime
serves its HTTP API on `127.0.0.1` from a dedicated thread and is restarted
when the user switches workspace folders. There is no separate runtime binary
to download or pin.

## Start the desktop client

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` runs `tauri dev`, which compiles the shell together with the
runtime crates.

## Crate layout

| Crate | Responsibility |
| --- | --- |
| `kition-api` | Dependency setup, route assembly, and the standalone `kition-api` binary used by inspection scripts. |
| `kition-core` | Configuration, errors, events, time, and runtime info. |
| `kition-http` | Auth, CORS and loopback `Host` checks, extractors. |
| `kition-store` | The SQLite database, schema, and migrations. |
| `kition-ai` | Model providers (OpenAI Responses and Anthropic Messages), streaming, retries, and image generation. |
| `kition-agent` | Agent sessions, the streamed agent turn, its tools, the execution policy, and MCP servers. |
| `kition-datadoc` / `kition-kitable` | Data documents, `.kitable` files, AI fields, and the scenario builder. |
| `kition-table-api` | The table document requests (records, fields, views, history, transactions, dashboards) as JSON in and out over an open `.kitable` file; `kition-datadoc`'s routes are adapters over it. No server or async runtime, so it builds for `wasm32`. |
| `kition-time` | Millisecond timestamps, without runtime dependencies (re-exported by `kition-core`). |
| `kition-workflow` | Workflow definitions, triggers, runs, and the AI workflow builder. |
| Other crates | Connections, email and form sync, desktop features, and workspace storage. |

## Checks

```bash
pnpm check:desktop
```

This runs `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`,
`cargo test --workspace`, and `scripts/check-wasm.sh`: `cargo check --target
wasm32-unknown-unknown` for `kition-kitable` and `kition-table-api`. That check needs the Rust
target (`rustup target add wasm32-unknown-unknown`) and a C compiler that targets wasm32 for
SQLite (Homebrew `llvm`, or `CC_wasm32_unknown_unknown` and `AR_wasm32_unknown_unknown`); without
them it is skipped with a notice, and `KITION_REQUIRE_WASM_CHECK=1` makes that an error.

## Rules

- The local API is unauthenticated: it binds to `127.0.0.1` only and rejects
  requests whose `Host` header is not loopback.
- Contracts in `contracts/runtime/` describe what the renderer relies on.
  Change the contract, the renderer, and the runtime together.
- Secrets never enter the repository. Signing keys, updater keys, and portal
  credentials live in CI secrets or on the developer's machine.
- Agent tools that touch the network or the shell must keep their guards:
  public-address checks for web reads, and the execution policy for commands.
