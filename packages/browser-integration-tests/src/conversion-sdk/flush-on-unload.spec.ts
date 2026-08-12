import { test, expect } from '@playwright/test'
import { assertSdkBundleExists, gotoTestLp, setupCollectMock } from './helpers'

test.beforeAll(() => {
  assertSdkBundleExists()
})

test.describe('Conversion SDK — flush on unload', () => {
  test('flushes pending events on page navigation (pagehide) via keepalive fetch', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      navigator.sendBeacon = () => false
    })

    const { bodies } = await setupCollectMock(page)
    await gotoTestLp(page)

    const batchesBefore = bodies.length

    await page.click('#track-impression')
    await page.goto('/conversion-sdk/blank.html')

    await expect
      .poll(() => bodies.length, { timeout: 10000 })
      .toBeGreaterThan(batchesBefore)

    const newBatches = bodies.slice(batchesBefore)
    const impression = newBatches
      .flatMap((b) => b)
      .find((e) => e.event === 'impression')

    expect(impression).toBeDefined()
    expect(impression?.properties?.block_id).toBe('top_father')
    expect(typeof impression?.context.sessionId).toBe('string')
  })

  test('uses real sendBeacon on pagehide when available', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'sendBeacon', {
        value: (url: string, data: BodyInit) => {
          ;(window as any).__beaconUrl = url
          ;(window as any).__beaconData = data
          return true
        },
        configurable: true,
        writable: true,
      })
    })

    await gotoTestLp(page)
    await page.click('#track-impression')

    // Navigating away would destroy the page's JS context before the captured
    // beacon args could be read back, so `pagehide` is dispatched in place
    // instead of navigating to blank.html. This runs the SDK's real `pagehide`
    // handler (a `window` listener) — which calls `navigator.sendBeacon` with
    // the collect endpoint and a Blob — while keeping the window that recorded
    // the call alive. The poll re-fires the event until the impression has
    // reached the collector buffer, since the click's track pipeline settles
    // asynchronously.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => {
            window.dispatchEvent(new Event('pagehide'))
          })
          return page.evaluate(() => (window as any).__beaconUrl ?? null)
        },
        { timeout: 10000 }
      )
      .toBe('/v1/conversion/collect')

    // Blob is a browser global — the `instanceof` check must run in the page,
    // where the captured value is the original Blob instance (it cannot be
    // serialized out to the Node side).
    const beaconDataIsBlob = await page.evaluate(() => {
      const data = (window as any).__beaconData
      return data != null && data instanceof Blob
    })
    expect(beaconDataIsBlob).toBe(true)
  })

  test('flushes on visibilitychange hidden', async ({ page }) => {
    const { bodies } = await setupCollectMock(page)
    await gotoTestLp(page)

    await page.click('#track-impression')

    // Simulate tab going to background / user switching tabs
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await expect
      .poll(
        () =>
          bodies.some((b) => b?.some((e) => e.event === 'impression') ?? false),
        { timeout: 10000 }
      )
      .toBe(true)
  })
})
