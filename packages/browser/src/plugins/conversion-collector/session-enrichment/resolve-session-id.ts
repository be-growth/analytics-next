import { generateUuidV4, isValidUuidV4 } from '../lib/uuid'
import type { ConversionCollectorSettings } from '../types'
import { getOrCreateSessionId } from './session-manager'

/**
 * Resolves the session id for an event, preferring the host-supplied
 * `getSessionId` override.
 *
 * The override is validated because the collector rejects anything that is not a
 * UUID v4 (`invalid_session_id`) — an empty string or a legacy id would fail the
 * whole batch, so falling back to the cookie-backed session is strictly better.
 *
 * It is also called inside a try/catch, and that matters more than it looks:
 * `sessionEnrichment` runs as an `enrichment` plugin, and the core executes
 * those through `attempt()`, which logs a thrown error and lets the event
 * continue. A host override that throws would therefore ship every event to the
 * collector with no `context.sessionId` at all — silently, and for that whole
 * site. This function must never throw.
 */
export function resolveSessionId(
  settings: ConversionCollectorSettings,
  onInvalidOverride?: (received: string) => void
): string {
  try {
    const custom = settings.getSessionId?.()
    if (custom) {
      if (isValidUuidV4(custom)) {
        return custom
      }
      onInvalidOverride?.(custom)
    }
  } catch (error) {
    onInvalidOverride?.(`threw: ${String(error)}`)
  }

  try {
    return getOrCreateSessionId({ cookieDomain: settings.sessionCookieDomain })
  } catch (error) {
    // Last resort: a session-less event is invisible downstream (the
    // session_profiles materialized views filter `session_id != ''`), so an
    // ephemeral id is strictly better than none.
    onInvalidOverride?.(`session manager threw: ${String(error)}`)
    return generateUuidV4()
  }
}
