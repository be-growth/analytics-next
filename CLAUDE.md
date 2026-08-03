# Conversion SDK contract rules

## SDK ↔ collector wire contract

The versioned contract under
`packages/conversion-pipeline-collector/src/contract/` defines the canonical
payload emitted by the browser SDK.

- Do not rename, remove, or change the meaning/type of a frozen field without
  creating a new contract version and a compatibility plan.
- `context.sessionId` is the canonical SDK field for the cookie-backed session.
  Do not replace it with `context.session_id` in native SDK payloads.
- Changes to payload serialization, context enrichment, session handling, or
  event field names must pass the contract tests in the SDK and the
  compatibility tests in the Collector and worker.
- Adding an optional field is allowed in the current version only when old
  collectors can safely ignore it.
- Breaking changes require a new version, parallel support during migration,
  updated fixtures, and an explicit PR note.

The contract fixtures are test/docs dependencies only; production code must
not import the contract module as a runtime dependency.
