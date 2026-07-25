# Account Contract

`account-session.schema.json` defines the public desktop contract consumed by
Kition. The private account and billing service owns authentication, plan
entitlements, the credit ledger, and hosted-model routing.

The desktop client may persist the complete session in secure storage, but it
must never display access tokens, refresh tokens, token prefixes, or internal
session identifiers. Customer-facing account surfaces consume only identity,
plan, subscription, credit, and action URL fields.

All action URLs are optional. The client validates their protocol before
opening them and uses public Kition fallbacks where the product already has a
documented destination.
