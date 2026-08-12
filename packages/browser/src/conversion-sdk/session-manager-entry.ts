import {
  getOrCreateSessionId,
  getCurrentSessionId,
  resetSessionMemory,
  SESSION_COOKIE,
  ACTIVITY_COOKIE,
  SESSION_LS_KEY,
  ACTIVITY_LS_KEY,
  SESSION_INACTIVITY_MS,
  SESSION_COOKIE_MAX_AGE_SEC,
} from '../plugins/conversion-collector/session-enrichment/session-manager'

export {
  getOrCreateSessionId,
  getCurrentSessionId,
  resetSessionMemory,
  SESSION_COOKIE,
  ACTIVITY_COOKIE,
  SESSION_LS_KEY,
  ACTIVITY_LS_KEY,
  SESSION_INACTIVITY_MS,
  SESSION_COOKIE_MAX_AGE_SEC,
}

/**
 * Standalone session-manager bundle, consumed synchronously by Ad Inserter
 * (wordpress-snippets). The script tag is loaded with no async/defer, so the
 * session id is minted and published to `window.UTUA_SESSION_ID` before any
 * inline targeting code runs. All logic comes from the existing manager — no
 * session behavior is reimplemented here.
 */
const sessionId = getOrCreateSessionId()

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).UTUA_SESSION_ID = sessionId
}

const UtuaSession = {
  getOrCreateSessionId,
  getCurrentSessionId,
  resetSessionMemory,
  SESSION_COOKIE,
  ACTIVITY_COOKIE,
  SESSION_LS_KEY,
  ACTIVITY_LS_KEY,
  SESSION_INACTIVITY_MS,
  SESSION_COOKIE_MAX_AGE_SEC,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).UtuaSession = UtuaSession
}

export default UtuaSession
