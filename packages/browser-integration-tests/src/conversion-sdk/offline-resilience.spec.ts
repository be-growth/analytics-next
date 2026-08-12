import { test, expect, type Page } from '@playwright/test'
import {
  assertSdkBundleExists,
  gotoTestLp,
  hasNoPersistedQueueKeys,
  hasPersistedQueueEvents,
  parseCollectBody,
  readPersistedQueueEvents,
} from './helpers'

test.beforeAll(() => {
  assertSdkBundleExists()
})

/**
 * The unload flush prefers navigator.sendBeacon, which is fire-and-forget: the
 * SDK treats an accepted beacon as delivered and drops the batch from the
 * queue. Disable it so page.reload() takes the keepalive-fetch path instead,
 * which on failure leaves the queue persisted — the behavior this spec is
 * asserting. (Same setup as flush-on-unload.spec.ts.)
 */
async function disableSendBeacon(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false
  })
}

test.describe('Conversion SDK — offline resilience', () => {
  test('retries and delivers after collector recovers', async ({ page }) => {
    await disableSendBeacon(page)

    let failCollect = true
    const bodies: ReturnType<typeof parseCollectBody>[] = []

    await page.route('**/v1/conversion/collect', async (route) => {
      const request = route.request()
      if (request.method() !== 'POST') {
        return route.continue()
      }

      if (failCollect) {
        return route.fulfill({ status: 503, body: 'unavailable' })
      }

      const body = parseCollectBody(request.postData())
      if (body) {
        bodies.push(body)
      }
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, queued: body?.length ?? 0 }),
      })
    })

    await gotoTestLp(page)
    await page.click('#track-impression')

    await expect
      .poll(() => page.evaluate(hasPersistedQueueEvents), { timeout: 5000 })
      .toBe(true)

    failCollect = false

    await expect
      .poll(
        () =>
          bodies.some((b) => b?.some((e) => e.event === 'impression') ?? false),
        { timeout: 20000 }
      )
      .toBe(true)
  })

  test('persists queue in localStorage and recovers after page reload', async ({
    page,
  }) => {
    await disableSendBeacon(page)

    let failCollect = true
    const messageIdsBeforeReload: string[] = []
    const bodiesAfterRecovery: ReturnType<typeof parseCollectBody>[] = []

    await page.route('**/v1/conversion/collect', async (route) => {
      const request = route.request()
      if (request.method() !== 'POST') {
        return route.continue()
      }

      if (failCollect) {
        return route.fulfill({ status: 503, body: 'unavailable' })
      }

      const body = parseCollectBody(request.postData())
      if (body) {
        bodiesAfterRecovery.push(body)
      }
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, queued: body?.length ?? 0 }),
      })
    })

    await gotoTestLp(page)

    await page.click('#track-impression')
    await expect
      .poll(() => page.evaluate(hasPersistedQueueEvents), { timeout: 5000 })
      .toBe(true)

    // Collect messageIds from localStorage before reload
    messageIdsBeforeReload.push(
      ...(await page.evaluate(readPersistedQueueEvents))
        .map((e) => e.messageId ?? '')
        .filter(Boolean)
    )
    expect(messageIdsBeforeReload.length).toBeGreaterThan(0)

    // Reload the page — collector still failing, queue persists in localStorage
    await page.reload()
    await expect
      .poll(() => page.evaluate(hasPersistedQueueEvents), { timeout: 5000 })
      .toBe(true)

    const messageIdsAfterReload = (
      await page.evaluate(readPersistedQueueEvents)
    )
      .map((e) => e.messageId ?? '')
      .filter(Boolean)
    expect(messageIdsAfterReload.length).toBeGreaterThan(0)

    const afterSet = new Set(messageIdsAfterReload)
    const survived = messageIdsBeforeReload.filter((id) => afterSet.has(id))
    expect(survived.length).toBeGreaterThan(0)

    // Recover collector and verify delivery
    failCollect = false
    await page.reload()
    await expect
      .poll(() => page.evaluate(hasPersistedQueueEvents), { timeout: 5000 })
      .toBe(true)

    await page.click('#track-impression')

    // After collector recovers, the reloaded page should deliver the persisted events
    await expect
      .poll(
        () =>
          bodiesAfterRecovery.some(
            (b) => b?.some((e) => e.event === 'impression') ?? false
          ),
        { timeout: 20000 }
      )
      .toBe(true)

    // Queue is drained and removed from localStorage once everything is delivered
    await expect
      .poll(() => page.evaluate(hasNoPersistedQueueKeys), { timeout: 5000 })
      .toBe(true)
  })
})
