# Product Analytics Contract

`product-event.schema.json` defines the public, privacy-bounded event contract
emitted by the Kition desktop client.

Product analytics are disabled by default. Enabling analytics creates a
separate anonymous installation identifier used only for this event stream.
Disabling analytics aborts active delivery and removes the local queue,
one-time event markers, and analytics identifier.

The client accepts only the fields declared by the schema. Event payloads must
never contain document names, workspace paths, document contents, prompts,
model responses, API keys, tokens, URLs, browser history, email addresses, or
account identifiers. Product events are separate from crash and support
diagnostics.

When `KITION_ANALYTICS_ENDPOINT` is configured at build time, the client sends
JSON batches with this shape:

```json
{
  "schema": "kition-analytics-batch/v1",
  "events": []
}
```

Delivery is best-effort. Offline and transport failures leave the bounded
queue on the device and never block product workflows.
