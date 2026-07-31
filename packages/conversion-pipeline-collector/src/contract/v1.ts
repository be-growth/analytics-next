/**
 * AU-191: Conversion SDK ↔ Collector wire contract v1.
 *
 * This module freezes the JSON shape that the browser SDK sends on
 * `POST /collect` to the Collector. It is **type-only** at runtime —
 * the production code in `../normalize.ts`, `../parse-body.ts` and
 * `../collect-handler.ts` does NOT import from this module. The contract
 * exists so tests, fixtures and docs have a single source of truth for
 * the v1 wire format.
 *
 * Rules of the contract:
 * 1. The wire format described here is what the SDK currently produces
 *    in production — it is not aspirational.
 * 2. Any breaking change to a field listed in `FROZEN_PAYLOAD_KEYS`
 *    requires a new contract version (v2). See `README.md` in this
 *    folder for the versioning policy.
 * 3. Adding a new optional field is backwards-compatible and does NOT
 *    require a new version.
 *
 * Do NOT re-export this module from `../index.ts`. It is intentionally
 * excluded from the published package and from the build output.
 */

/** Top-level discriminator values accepted by the Collector. */
export type V1EventType = 'track' | 'page' | 'identify' | 'screen'

/** The native analytics-next payload sent on the wire (camelCase). */
export type V1CollectEvent = Record<string, unknown> & {
  type: V1EventType
  /** Required for `type === 'track'`; the event name (e.g. `impression`). */
  event?: string
  /** Required identity. UUID v4 in production traffic. */
  anonymousId: string
  /** Optional identity, populated after `identify()`. */
  userId?: string
  /** Identify traits (PII — hashed server-side by the Collector). */
  traits?: Record<string, unknown>
  /** Track / page properties (ad-tech, UTMs, taxonomy). */
  properties?: Record<string, unknown>
  /** Required. Contains the session id and env metadata. */
  context: V1CollectContext
  /** Required. UUID v4, stable across retries for dedup. */
  messageId: string
  /** ISO 8601 — when the SDK captured the event. */
  timestamp?: string
  /** ISO 8601 — when the SDK flushed the batch. */
  sentAt?: string
  /** ISO 8601 — alias of `timestamp` set by analytics-next core. */
  originalTimestamp?: string
  /** Always present in native traffic; retry counter for the batch. */
  _metadata?: { retryCount?: number }
}

export type V1CollectContext = Record<string, unknown> & {
  /** Required. UUID v4 — primary key for Collector / Redis aggregation. */
  sessionId: string
  /** App identity, stamped by `app-enrichment` (AU-165). */
  app?: { name?: string }
  /** SDK library identity, stamped by `app-enrichment` (AU-165). */
  library?: { name?: string; version?: string }
  /** Channel discriminator — always `"browser"` in v1. */
  channel?: string
  /** Page metadata, populated by `env-enrichment`. */
  page?: {
    url?: string
    path?: string
    title?: string
    referrer?: string
    search?: string
  }
  /** Attribution source — UTMs and click-ids (canonical). */
  campaign?: Record<string, unknown>
  /** Repeated in `track` after `identify` for convenience. */
  traits?: Record<string, unknown>
  /** Browser locale, populated by `env-enrichment`. */
  locale?: string
  /** Screen dimensions, populated by `env-enrichment`. */
  screen?: { width?: number; height?: number }
  /** IANA timezone, populated by `env-enrichment`. */
  timezone?: string
  /** User agent, populated by `env-enrichment`. */
  userAgent?: string
}

/**
 * Critical payload key paths the Collector depends on. The contract test
 * asserts that every fixture satisfies every path and that mutating any
 * of them breaks the production pipeline in a detectable way.
 *
 * Updating this list is a contract change and MUST be paired with a
 * version bump (see `README.md`).
 */
export const FROZEN_PAYLOAD_KEYS = [
  'type',
  'event',
  'anonymousId',
  'messageId',
  'userId',
  'context.sessionId',
  'context.app.name',
  'context.library.name',
  'context.library.version',
  'context.campaign.source',
  'context.campaign.medium',
  'context.campaign.name',
  'context.campaign.gclid',
  'context.page.url',
  'context.page.path',
  'context.page.title',
  'context.page.referrer',
  'properties.block_id',
  'properties.block_position',
  'properties.ad_request_id',
  'properties.viewable',
  'properties.utm_source',
  'properties.utm_medium',
  'properties.utm_campaign',
  'properties.utm_content',
  'properties.utm_term',
  'properties.gclid',
  'properties.fbclid',
  'properties.ttclid',
  'properties.msclkid',
  'properties.twclid',
  'properties.query_params',
  'properties.visitor_country',
  'properties.country',
  'properties.vertical',
  'properties.product',
  'properties.funnel',
  'properties.page_path',
  'traits.email',
  'traits.email_hash',
  'traits.email_domain',
  'traits.phone',
  'traits.phone_hash',
  'timestamp',
  'sentAt',
  'originalTimestamp',
  '_metadata.retryCount',
] as const

export type FrozenPayloadKey = (typeof FROZEN_PAYLOAD_KEYS)[number]

/**
 * Frozen contract version identifier. The string is referenced by the
 * contract test so any drift between the doc and the code is detected.
 */
export const V1_CONTRACT_VERSION = 'v1' as const
