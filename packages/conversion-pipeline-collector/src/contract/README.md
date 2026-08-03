# Conversion SDK ↔ Collector wire contract — v1

> **Status:** Frozen for contract v1. See [versioning rules](#versioning-rules)
> before changing anything in this folder.

This folder is the **versioned source of truth** for the JSON payload that the
browser SDK ships on `POST /collect` to the Collector. It lives in the SDK
repository because the SDK produces the canonical wire format. The Go
Collector and worker keep their own runtime structs and validate compatibility
with these fixtures in their tests; they do not depend on this package at
runtime.

The contract is:

- **Type-only** — `v1.ts` is consumed by tests and docs, not by the
  production runtime code in `src/normalize.ts`, `src/parse-body.ts` or
  `src/collect-handler.ts`.
- **Frozen** — the field paths in `FROZEN_PAYLOAD_KEYS` MUST NOT be
  renamed or removed without a version bump.
- **Test-guarded** — `src/__tests__/contract.test.ts` parses the fixtures
  through the real `parseCollectBody` + `normalizeCollectEvent` pipeline,
  checks the frozen-key snapshot and maps every frozen key to its real
  `FlatEvent` column, JSON bucket or PII hash output.

The folder is excluded from the package build
(`tsconfig.build.json`) and from the published npm `files` list
(`package.json`) — production runtime never ships it. The source remains in
the repository for tests and documentation.

---

## Wire format at a glance

```http
POST /collect
Content-Type: application/json

[
  { /* V1CollectEvent */ },
  { /* V1CollectEvent */ }
]
```

The full TypeScript shape lives in [`v1.ts`](./v1.ts). The canonical JSON
payloads live in [`fixtures/`](./fixtures/).

### Required fields per event

| Path                | Why it is required                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `type`              | Top-level discriminator (`track` \| `page` \| `identify` \| `screen`). The Collector rejects unknown values. |
| `anonymousId`       | Visitor identity. UUID v4 in production traffic.                                                             |
| `messageId`         | UUID v4, stable across retries — used for server-side dedup.                                                 |
| `context.sessionId` | UUID v4 — primary key for Collector / Redis session aggregation. **This is the canonical session key.**      |

### Frozen optional fields

All paths in `FROZEN_PAYLOAD_KEYS` are part of v1 and must keep their
shape. New optional fields MAY be added in v1.x; renames or removals
require a v2.

---

## Versioning rules

| Change                                                                     | Allowed in v1?       |
| -------------------------------------------------------------------------- | -------------------- |
| Add a new optional field anywhere in the payload                           | ✅ (no version bump) |
| Add a new entry to `FROZEN_PAYLOAD_KEYS` for a field the SDK already emits | ✅                   |
| Add a new top-level discriminator value to `V1EventType`                   | ❌ (v2)              |
| Rename any frozen key (e.g. `context.sessionId` → `context.session.id`)    | ❌ (v2)              |
| Remove any frozen key                                                      | ❌ (v2)              |
| Change the type of any frozen field                                        | ❌ (v2)              |
| Change the wire envelope from `[CollectEvent, ...]` to anything else       | ❌ (v2)              |

When a v2 contract is needed:

1. Add `v2.ts` next to `v1.ts`. It MUST declare its own `FROZEN_PAYLOAD_KEYS_V2`.
2. Add `fixtures/v2/` with representative payloads.
3. Keep the v1 fixtures unchanged for the lifetime of the migration.
4. The Collector MUST accept v1 in parallel for at least one full
   release window — see `docs/conversion-sdk/migration-rollout.md`.
5. Keep `V1_CONTRACT_VERSION` unchanged; v1 remains frozen.

---

## Fixture catalogue

| File                             | Discriminator          | Notes                                                                                                  |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `fixtures/track-impression.json` | `track` / `impression` | Full payload: ad-tech properties, campaign, page, traits, env metadata.                                |
| `fixtures/track-ad-request.json` | `track` / `ad_request` | Minimum viable `ad_request` payload (drives `quality_flag: incomplete` if `ad_request_id` is missing). |
| `fixtures/identify.json`         | `identify`             | Email + phone in `traits` — exercises the Collector PII hashing path.                                  |
| `fixtures/page.json`             | `page`                 | Demonstrates the `properties.*` / `query_params` attribution fallback path.                            |

Every fixture uses a different `messageId` so they can be batched in a
single `[CollectEvent, ...]` array without colliding.

---

## How the contract is enforced

### Collector contract gate

`src/__tests__/contract.test.ts` loads the representative fixtures and runs
production parsing and normalisation. It currently verifies:

1. `FROZEN_PAYLOAD_KEYS` still matches the initial v1 snapshot.
2. The canonical `track-impression` fixture expresses the complete frozen
   field set; the other fixtures validate the frozen fields they express.
3. Every frozen key is explicitly mapped from `normalizeCollectEvent` output
   to a dedicated `FlatEvent` column or, where no dedicated column exists, to
   `properties_json` or `context_json`. Raw email and phone fields are mapped
   to their hashed `FlatEvent` outputs rather than asserted as raw PII.
4. Fixtures pass through `parseCollectBody` + `normalizeCollectEvent`, and
   identity fields including canonical `context.sessionId` reach the expected
   `FlatEvent` columns.
5. Critical validation tripwires reject a missing or invalid session ID,
   missing `anonymousId`, missing `messageId` and an unknown event type.

These are focused contract assertions, not a general mutation-testing suite.
In particular, there are no mutation tests for `context.app.name` or the
`context.library.*` fields.

### Browser producer gate

`packages/browser-integration-tests/src/conversion-sdk/wire-contract.spec.ts`
is the real Playwright producer gate. It serves the wire-contract page, executes
the built browser SDK bundle, intercepts the actual `POST /collector` request
and inspects the initial page event. The gate requires:

- `context.sessionId` to be a UUID v4;
- legacy `context.session_id` to be absent;
- `context.app.name` to contain the expected app name; and
- `context.library.name` and `context.library.version` to be present.

The gate deliberately keeps the browser's normal producer flow; it does not
construct a fixture and submit it in place of the SDK.

### Session behavior outside these gates

The contract and producer gates validate the canonical key and UUID v4 shape,
but they do **not** cover session lifecycle behavior. Cookie TTL,
session rotation/renewal, cross-tab behavior and other persistence semantics
remain outside their scope and must continue to be covered by their dedicated
session tests or integration lanes.

If a future change renames a frozen input path, removes its output mapping or
changes canonical session emission, the corresponding gate should fail before
the change ships.

---

## Related docs

- `docs/conversion-sdk/backend-contract.md` — the high-level contract
  spec (read alongside this folder for full context).
- `docs/conversion-sdk/event-schema.md` — per-event-type requirements.
- `docs/conversion-sdk/migration-rollout.md` — rollout / migration
  policy (referenced when bumping the contract version).
