import { test, expect } from '@playwright/test'
import {
  assertSdkBundleExists,
  type CollectBody,
  parseCollectBody,
  setupCollectMock,
} from './helpers'

/**
 * Browser producer wire contract.
 *
 * Goal: a focused, fast-running check that does NOT depend on
 * the segmentio/sdk-e2e-tests repo (no E2E_TESTS_TOKEN required)
 * and verifies the SDK ships the canonical wire payload on the
 * initial page event.
 *
 * Concretely, on the first POST to `/v1/conversion/collect` (the real
 * collector route):
 *   - `context.sessionId` is present (UUID v4)
 *   - `context.session_id` is absent (the legacy snake_case key is
 *     NOT used by the native SDK — see CLAUDE.md)
 *   - `context.app.name` is present
 *   - `context.library.name` and `context.library.version` are present
 *
 * Out of scope for this gate (handled by other tests / lanes):
 *   - Complete frozen-key golden map
 *   - Cookie TTL / rotation behaviour
 *   - Shared golden fixtures
 */
test.beforeAll(() => {
  assertSdkBundleExists()
})

test.describe('browser producer wire contract', () => {
  test('initial page event emits canonical wire payload to /v1/conversion/collect', async ({
    page,
  }) => {
    const captured: CollectBody[] = []
    const { bodies } = await setupCollectMock(page, (batch) => {
      captured.push(batch)
    })

    await page.goto('/conversion-sdk/wire-contract.html')

    await expect
      .poll(() => bodies.length, { timeout: 10000 })
      .toBeGreaterThan(0)

    // Sanity: the route handler actually saw the array body.
    expect(captured.length).toBeGreaterThan(0)
    const batch = captured[0]!
    expect(Array.isArray(batch)).toBe(true)
    expect(batch.length).toBeGreaterThan(0)

    const pageEvent = batch.find((e) => e.type === 'page' || e.event === 'page')
    expect(pageEvent).toBeDefined()

    const ctx = (pageEvent?.context ?? {}) as Record<string, unknown>

    // 1. context.sessionId is present and is a UUID v4 (canonical SDK field).
    const sessionId = ctx.sessionId
    expect(sessionId).toEqual(expect.any(String))
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )

    // 2. context.session_id is absent (never the snake_case variant).
    expect(ctx.session_id).toBeUndefined()

    // 3. context.app.name is present (stamped by app-enrichment).
    const app = ctx.app as { name?: string } | undefined
    expect(app?.name).toBe('wire-contract')

    // 4. context.library.name and version are present.
    const library = ctx.library as
      | { name?: string; version?: string }
      | undefined
    expect(library?.name).toBe('conversion-analytics-sdk')
    expect(typeof library?.version).toBe('string')
    expect((library?.version ?? '').length).toBeGreaterThan(0)

    // Defensive: the parse helper round-trips the same payload.
    expect(parseCollectBody(JSON.stringify(batch))).toEqual(batch)
  })
})
