# Table File Import

Kition exposes a public, capability-gated import contract for converting CSV,
TSV, and XLSX files into Kitable resources. The client, mocks, fixtures,
and black-box behavior live in this repository. Parser internals, transactions,
job persistence, and private implementation tests belong in the private
runtime repository.

## Capabilities

- `table_file_import_v1`: preview and execute the public import protocol.
- `table_file_import_xlsx_v1`: parse XLSX workbook sources.
- `table_file_import_async_v1`: persist, poll, and cancel asynchronous jobs.

The client must not call the new endpoints until `table_file_import_v1` is
advertised. CSV and TSV retain a deterministic client compatibility path for
older runtimes. Workbooks require the XLSX capability and never fall back to
AI parsing.

Legacy XLS files are not part of this contract. Save them as XLSX before
importing.

## Public endpoints

```text
POST   /v1/data-imports/preview
POST   /v1/data-imports
GET    /v1/data-imports/:jobId
DELETE /v1/data-imports/:jobId
```

The canonical request and response definitions are in
`contracts/runtime/data-import.schema.json`.

Preview detects the source format, encoding, delimiter, workbook sheets,
record count, inferred fields, sample values, and warnings. Execution consumes
the returned import token, an explicit target, a write mode, a schema mode,
optional reviewed field overrides, and an idempotency key.

## Runtime behavior

Runtime implementations must provide these observable guarantees:

- File parsing and record generation are deterministic and do not use an LLM.
- Workspace sources use portable workspace-relative paths.
- New-document writes finalize atomically.
- Existing-table writes are transactional or provide equivalent rollback.
- Failed and canceled jobs do not leave partial fields or records.
- Reusing an idempotency key does not duplicate records.
- Result counts report total, created, updated, skipped, and field mutations.

## Agent behavior

The Agent may resolve the source file, target table, sheet, and write mode. It
must delegate parsing and writing to the import protocol. It must not sample a
file and recreate rows with table mutation tools.
