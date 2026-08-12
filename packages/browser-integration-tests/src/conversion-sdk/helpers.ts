import type { Page, Route } from '@playwright/test'
import { expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

export type CollectEventPayload = {
  type: string
  event?: string
  context: Record<string, unknown>
  properties?: Record<string, unknown>
  traits?: Record<string, unknown>
}

/** Native analytics-next POST body: JSON array of events. */
export type CollectBody = CollectEventPayload[]

export function parseCollectBody(raw: string | null): CollectBody | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed as CollectBody
    }
    return null
  } catch {
    return null
  }
}

export function sdkBundlePath(): string {
  return path.resolve(__dirname, '../../../browser/dist/umd/sdk.min.js')
}

export function assertSdkBundleExists(): void {
  const bundle = sdkBundlePath()
  if (!fs.existsSync(bundle)) {
    throw new Error(
      `Missing ${bundle}. Run: yarn workspace @segment/analytics-next build:conversion-sdk`
    )
  }
}

export type PersistedQueueEvent = {
  event?: string
  messageId?: string
}

/**
 * Reads the queue the conversion SDK persists to localStorage. The SDK keeps a
 * per-tab queue under `utua_event_queue::<owner>` (envelope `{ owner,
 * updatedAt, events }`) and still adopts the legacy single key
 * `utua_event_queue` (bare array) on boot, so both are accounted for. Runs in
 * the browser context via page.evaluate — must stay self-contained.
 */
export function readPersistedQueueEvents(): PersistedQueueEvent[] {
  const events: PersistedQueueEvent[] = []
  const seen = new Set<string>()

  const push = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const item = value as { event?: unknown; messageId?: unknown }
    const id = typeof item.messageId === 'string' ? item.messageId : undefined
    if (id) {
      if (seen.has(id)) return
      seen.add(id)
    }
    events.push({
      event: typeof item.event === 'string' ? item.event : undefined,
      messageId: id,
    })
  }

  const pushStored = (raw: string | null): void => {
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        parsed.forEach(push)
        return
      }
      if (parsed && typeof parsed === 'object') {
        const envelope = parsed as { events?: unknown }
        if (Array.isArray(envelope.events)) {
          envelope.events.forEach(push)
        }
      }
    } catch {
      // malformed value — nothing to recover
    }
  }

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key && key.startsWith('utua_event_queue::')) {
      pushStored(window.localStorage.getItem(key))
    }
  }
  pushStored(window.localStorage.getItem('utua_event_queue'))

  return events
}

/** True when the SDK has a non-empty queue persisted in localStorage. */
export function hasPersistedQueueEvents(): boolean {
  const hasEvents = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.length > 0
    const envelope = value as { events?: unknown }
    return Array.isArray(envelope.events) && envelope.events.length > 0
  }
  const hasStored = (raw: string | null): boolean => {
    if (!raw) return false
    try {
      return hasEvents(JSON.parse(raw))
    } catch {
      return false
    }
  }

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key && key.startsWith('utua_event_queue::')) {
      if (hasStored(window.localStorage.getItem(key))) return true
    }
  }
  return hasStored(window.localStorage.getItem('utua_event_queue'))
}

/** True when no queue key (per-tab or legacy) remains in localStorage. */
export function hasNoPersistedQueueKeys(): boolean {
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (!key) continue
    if (key.startsWith('utua_event_queue::') || key === 'utua_event_queue') {
      return false
    }
  }
  return true
}

export async function setupCollectMock(
  page: Page,
  onCollect?: (body: CollectBody) => void
): Promise<{ bodies: CollectBody[] }> {
  const bodies: CollectBody[] = []

  await page.route('**/v1/conversion/collect', async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'POST') {
      return route.continue()
    }

    const body = parseCollectBody(request.postData())
    if (body) {
      bodies.push(body)
      onCollect?.(body)
    }

    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        queued: body?.length ?? 0,
      }),
    })
  })

  return { bodies }
}

export async function gotoTestLp(
  page: Page,
  search = '?utm_source=e2e&utm_campaign=test'
): Promise<void> {
  await page.goto(`/conversion-sdk/test-lp.html${search}`)
  await page.waitForFunction(() => {
    const w = window as unknown as {
      analytics?: { loaded?: boolean }
    }
    return w.analytics?.loaded === true
  })
}

export function findEvent(
  body: CollectBody,
  eventName: string
): CollectEventPayload | undefined {
  return body.find(
    (e) => e.event === eventName || (eventName === 'page' && e.type === 'page')
  )
}

export function expectNormalizeReadyEvent(
  body: CollectBody,
  eventName: string
): void {
  const event = findEvent(body, eventName)
  expect(event).toBeDefined()
  const ctx = event?.context ?? {}
  expect(typeof ctx.sessionId).toBe('string')
  expect(ctx.session_id).toBeUndefined()
  const campaign = ctx.campaign as
    | { source?: string; name?: string }
    | undefined
  if (campaign?.source) {
    expect(typeof campaign.source).toBe('string')
  }
}
