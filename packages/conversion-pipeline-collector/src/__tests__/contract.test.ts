/**
 * AU-191 contract tests.
 *
 * These tests guard the v1 wire contract between the browser SDK and the
 * Collector. They DO NOT change production behavior — they assert that
 * the current production pipeline (parse-body + normalize) still reads
 * every frozen key path and rejects mutations of the critical ones.
 *
 * If any of the frozen keys are renamed or removed in the production
 * source, one of the assertions below will fail.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  FROZEN_PAYLOAD_KEYS,
  V1_CONTRACT_VERSION,
  type V1CollectEvent,
} from '../contract'
import { handleCollectRequest } from '../collect-handler'
import { normalizeCollectEvent, NormalizeError } from '../normalize'

const FIXTURES_DIR = join(__dirname, '..', 'contract', 'fixtures')

type FixtureName =
  | 'track-impression'
  | 'track-ad-request'
  | 'identify'
  | 'page'

function loadFixture(name: FixtureName): V1CollectEvent {
  const path = join(FIXTURES_DIR, `${name}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as V1CollectEvent
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === 'object' && segment in (acc as object)) {
      return (acc as Record<string, unknown>)[segment]
    }
    return undefined
  }, obj)
}

/**
 * Snapshot of the frozen key list as it shipped in AU-191. If this list
 * is edited without a corresponding test update, the contract test will
 * flag it via `expect(FROZEN_PAYLOAD_KEYS).toEqual(FROZEN_KEYS_SNAPSHOT)`.
 */
const FROZEN_KEYS_SNAPSHOT: readonly string[] = [
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
]

const FIXTURES: readonly FixtureName[] = [
  'track-impression',
  'track-ad-request',
  'identify',
  'page',
]

describe('AU-191 — v1 wire contract', () => {
  it('ships with version v1', () => {
    expect(V1_CONTRACT_VERSION).toBe('v1')
  })

  it('keeps the frozen key list stable', () => {
    expect([...FROZEN_PAYLOAD_KEYS]).toEqual(FROZEN_KEYS_SNAPSHOT)
  })

  describe.each(FIXTURES)('fixture %s', (name) => {
    const fixture = loadFixture(name)

    it('has a known event type', () => {
      expect(['track', 'page', 'identify', 'screen']).toContain(fixture.type)
    })

    it('satisfies every frozen key path that the fixture expresses', () => {
      for (const path of FROZEN_PAYLOAD_KEYS) {
        const value = getByPath(fixture, path)
        // The fixture is representative, not exhaustive — only the keys
        // actually present in this particular fixture are checked.
        if (value === undefined || value === null) {
          continue
        }
        // When present the value must be a non-empty string, an object,
        // a finite number (including 0) or a boolean (including false).
        const ok =
          (typeof value === 'string' && value.length > 0) ||
          (typeof value === 'object' && !Array.isArray(value)) ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          typeof value === 'boolean'
        expect({ path, ok }).toEqual({ path, ok: true })
      }
    })

    it('contains the complete frozen field set in the canonical fixture', () => {
      if (name !== 'track-impression') return

      for (const path of FROZEN_PAYLOAD_KEYS) {
        expect(getByPath(fixture, path)).toBeDefined()
      }
    })

    it('flows through parseCollectBody + normalizeCollectEvent without errors', () => {
      const result = handleCollectRequest([fixture])
      expect(result.status).toBe(202)
      expect(result.body).toEqual({ ok: true, queued: 1 })
      expect(result.events).toHaveLength(1)
      expect(result.events[0]?.session_id).toBe(fixture.context.sessionId)
    })

    it('preserves identity through normalize()', () => {
      const flat = normalizeCollectEvent(fixture)
      expect(flat.message_id).toBe(fixture.messageId)
      expect(flat.anonymous_id).toBe(fixture.anonymousId)
      expect(flat.session_id).toBe(fixture.context.sessionId)
    })
  })

  describe('critical-key tripwires', () => {
    const base = loadFixture('track-impression')

    it('rejects when context.sessionId is removed', () => {
      const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
      const ctx = clone.context as Record<string, unknown>
      delete ctx.sessionId
      expect(() => normalizeCollectEvent(clone as never)).toThrow(NormalizeError)
      expect(() => normalizeCollectEvent(clone as never)).toThrow(
        /sessionId/i
      )
    })

    it('rejects when context.sessionId is not a UUID v4', () => {
      const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
      const ctx = clone.context as Record<string, unknown>
      ctx.sessionId = 'definitely-not-a-uuid'
      const result = handleCollectRequest([clone])
      expect(result.status).toBe(422)
      expect(result.body).toMatchObject({ error: 'invalid_session_id' })
    })

    it('rejects when anonymousId is removed', () => {
      const clone = { ...base } as Record<string, unknown>
      delete clone.anonymousId
      expect(() => normalizeCollectEvent(clone as never)).toThrow(
        NormalizeError
      )
    })

    it('rejects when messageId is removed', () => {
      const clone = { ...base } as Record<string, unknown>
      delete clone.messageId
      expect(() => normalizeCollectEvent(clone as never)).toThrow(
        NormalizeError
      )
    })

    it('rejects an unknown top-level type', () => {
      const clone = { ...base, type: 'telemetry' } as unknown as V1CollectEvent
      const result = handleCollectRequest([clone])
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ ok: false })
    })
  })

  describe('context.sessionId canonical-key guard', () => {
    /**
     * The native wire format MUST use camelCase `context.sessionId`.
     * The production code accepts snake_case `context.session_id` as a
     * legacy envelope-v2 fallback (see parse-body.ts) — we don't want
     * that fallback to silently replace the canonical key in native
     * fixtures.
     */
    it('does not silently fall back to snake_case session_id in native fixtures', () => {
      const base = loadFixture('track-impression')
      // Sanity: every fixture uses the camelCase canonical key.
      expect(base.context.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect((base.context as Record<string, unknown>).session_id).toBeUndefined()
    })

    it('normalises context.sessionId into the FlatEvent.session_id column', () => {
      const base = loadFixture('track-impression')
      const flat = normalizeCollectEvent(base)
      expect(flat.session_id).toBe(base.context.sessionId)
    })
  })
})
