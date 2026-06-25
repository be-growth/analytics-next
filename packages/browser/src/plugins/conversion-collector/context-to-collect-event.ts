import { Analytics } from '../../core/analytics'
import { Context } from '../../core/context'
import type { CollectEvent } from './types'

const SUPPORTED_TYPES = new Set(['track', 'page', 'identify', 'screen'])

function cloneCollectValue<T>(value: T): T {
  if (Object.prototype.toString.call(value) === '[object Object]') {
    const cloned: Record<string, unknown> = {}
    for (const key in value as Record<string, unknown>) {
      cloned[key] = cloneCollectValue((value as Record<string, unknown>)[key])
    }
    return cloned as T
  }

  if (Array.isArray(value)) {
    return value.map(cloneCollectValue) as T
  }

  return value
}

/**
 * Maps an analytics-next context to the native Segment collect payload (no SDK-side flatten).
 *
 * Skips the heavy @segment/facade dependency by extracting the relevant fields
 * directly from the SegmentEvent — the facade .json() essentially returns
 * the original event object (this.obj) with the type normalized, but evt.type
 * is already correct for track/page/identify/screen.
 */
export function contextToCollectEvent(
  ctx: Context,
  _analytics: Analytics
): CollectEvent | null {
  const evt = ctx.event
  if (!evt.type || !SUPPORTED_TYPES.has(String(evt.type))) {
    return null
  }
  return {
    type: evt.type,
    event: evt.event,
    name: evt.name,
    category: evt.category,
    messageId: evt.messageId,
    anonymousId: evt.anonymousId,
    userId: evt.userId,
    sentAt: evt.sentAt,
    timestamp: evt.timestamp,
    properties: cloneCollectValue(evt.properties),
    traits: cloneCollectValue(evt.traits),
    context: cloneCollectValue(evt.context),
    integrations: cloneCollectValue(evt.integrations),
    _metadata: cloneCollectValue(evt._metadata),
  } as CollectEvent
}
