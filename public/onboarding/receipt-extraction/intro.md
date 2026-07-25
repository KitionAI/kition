# Receipt Extraction

This guide shows how file context can become structured, reviewable table data.

## Included table

`Receipt Archive.kitable` contains example rows for:

- source filename
- vendor and address
- expense category
- transaction date
- total and tax amount

Use Grid for review, then group or filter by category and date. The completed table is included so you can inspect the result without an AI provider.

## Run it with your own files

Attach receipt images to an AI-assisted table flow and use a prompt such as:

```text
Organize these receipts and extract vendor, address, category, date, total amount, and tax amount.
```

Review extracted values before exporting them to an accounting system. Source files remain under your control; Kition sends them to an AI provider only when you explicitly run the extraction action.
