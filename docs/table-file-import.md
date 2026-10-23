# Table File Import

Importing CSV, TSV, and XLSX files into a table is the Table kit's job
(`kit.table`, `KitionAI/kition-table`). Kition has no import API of its own:
the runtime's former `/v1/data-imports*` endpoints and their contract are
removed. The kit's engine answers `table.import.preview` and
`table.import.run`, described in the kit repository's
`docs/engine-commands.md`, and its editor imports into an open `.ktable`
file.

The import parses without a model, runs as one engine request (an import
that fails leaves the document as it was), and writes under an import origin
that never joins the person's undo; the kit repository specifies and tests
it. When an agent imports a file, it must use the kit's import commands,
never sample the file and recreate rows with record writes.
