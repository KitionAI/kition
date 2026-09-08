# Image template catalog HTTP contract

These are proposed public client boundaries for the Kition Cloud service,
implemented by `kition-console`. This repository contains the client and mocks;
it does not implement or deploy the service.

- `GET /api/media/image-templates` returns
  [the catalog schema](image-template-catalog.schema.json).
- `GET /api/media/image-templates/{id}?version={version}&locale={locale}` returns
  the schema's `$defs.template`, directly or inside a `data` envelope.

The list accepts `locale`, `surface`, `query`, `cursor`, `limit`, `operation`,
`has_reference_image`, and `has_selection_text`. The client requests 24 records
per page. The maximum is 100. Search runs on the server, and opaque cursors are
scoped to the query, locale, and catalog revision. A cursor must not repeat.
The optional `total_count` reports every match across pages, including templates
that require a reference. Browsing does not require a reference attachment;
`requires_reference_image` labels those templates and remains enforced at
submission and recipe resolution. Clients without count support keep paging
normally; clients talking to an older server show the page number.
The detail response must match both requested ID and immutable version. A
retired or unavailable version must return an error rather than a replacement.
Private prompt recipes never appear in client responses.

`POST /api/media/image-templates/{id}/resolve` is a Runtime-to-Console endpoint
using [the resolution contract](image-template-resolution.schema.json). The
runtime sends the pinned version, variables, instruction, operation, and reference
presence, without workspace paths or provider credentials. The service validates
the published version and access, interpolates recognized variables once, and
returns the compiled prompt with its SHA256. Public templates can be resolved
without an account; non-public templates require a server entitlement check and
must fail closed until that check is implemented. This endpoint does not inherit
the catalog's public browser CORS policy. Raw recipes stay out of catalog and
detail responses.

Requests carry `Accept-Language` and an optional bearer token from the active
Kition Account. Public catalog access and freeform image generation are
independent. Account and premium access are advisory labels; the server must
validate entitlement when resolving the template during generation. Clients
revalidate detail before submitting a pinned version. Auth failures should use
401 or 403, missing or retired versions 404 or 410, and temporary failures 503.

List responses may use `ETag`, `If-None-Match`, and 304. Cache representations
must vary by authorization, locale, and all query filters. The client caches at
most 20 queries in memory, always revalidates, and honors `Cache-Control:
no-store`. Detail requests bypass caches. Services must expose ETag to permitted
client origins and allow the Authorization and If-None-Match request headers.

Thumbnail and attribution links must use HTTPS. Catalog metadata must be
localized, falling back to English, without exposing private prompts, raw
editor context, credentials, or account data. Search requests contain only the
user's explicit search text and coarse surface/reference-presence filters.
