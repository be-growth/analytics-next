import { generateUuidV4, isValidUuidV4 } from '../lib/uuid'

export const SESSION_COOKIE = '_utua_session'
export const ACTIVITY_COOKIE = '_utua_last_activity'
export const SESSION_LS_KEY = 'utua_session'
export const ACTIVITY_LS_KEY = 'utua_last_activity'

/**
 * Inactivity window — must match the worker's `SESSION_INACTIVITY_TTL`
 * (30 minutes), which governs the Redis `session:` keys the finalizer reads.
 *
 * It used to be 5 minutes here against 30 in the worker. The browser rotated
 * the id four times inside one window the backend still considered a single
 * live session, so an ordinary 20-minute visit with reading pauses landed in
 * ClickHouse as several sessions — inflating session counts and splitting the
 * attribution across them.
 */
export const SESSION_INACTIVITY_MS = 30 * 60 * 1000

/**
 * Cookie max-age safety net. Deliberately longer than the inactivity window:
 * at equal values a user idling just under the window would find the cookie
 * already expired and start a new session anyway. The cookie is rewritten on
 * every event (see touchSessionStorage), so the extra margin never extends a
 * session on its own — expiry is decided by the inactivity logic.
 */
export const SESSION_COOKIE_MAX_AGE_SEC = 45 * 60

export interface SessionIdOptions {
  /** Host-supplied session id. Callers are expected to validate it beforehand. */
  custom?: () => string
  /** Emits the session cookies on this domain (e.g. `.utua.work`) so the session survives subdomain hops. */
  cookieDomain?: string
}

/**
 * Last-resort tier: keeps the session stable within a page load when cookies and
 * localStorage are both unavailable (Safari private mode/ITP, third-party iframe,
 * CMP blocking storage before consent). Without it every event mints a new id.
 */
let memorySessionId: string | null = null
let memoryLastActivity = 0

let hostOnlyCookiesCleared = false

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null
  }
  try {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${escaped}=([^;]*)`)
    )
    return match?.[1] != null ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

function setCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  domain?: string
): void {
  if (typeof document === 'undefined') {
    return
  }
  const maxAge = Math.max(1, Math.ceil(maxAgeSeconds))
  const secure =
    typeof window !== 'undefined' && window.location?.protocol === 'https:'
      ? '; Secure'
      : ''
  const domainAttr = domain ? `; domain=${domain}` : ''
  try {
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(
      value
    )}; path=/${domainAttr}; max-age=${maxAge}; SameSite=Lax${secure}`
  } catch {
    // cookies blocked
  }
}

/**
 * A host-only cookie and a `domain=` cookie coexist under the same name, and the
 * order `document.cookie` returns them in is unspecified — so a leftover host-only
 * cookie would make reads flip between two sessions. Drop it once per page load,
 * after the current session has already been read.
 */
function clearHostOnlyCookies(): void {
  if (hostOnlyCookiesCleared || typeof document === 'undefined') {
    return
  }
  hostOnlyCookiesCleared = true
  try {
    for (const name of [SESSION_COOKIE, ACTIVITY_COOKIE]) {
      document.cookie = `${encodeURIComponent(
        name
      )}=; path=/; max-age=0; SameSite=Lax`
    }
  } catch {
    // cookies blocked
  }
}

function readLs(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeLs(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    // storage blocked
  }
}

function toTimestamp(raw: string | null): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function touchSessionStorage(
  sessionId: string,
  activityMs: number,
  cookieDomain?: string
): void {
  memorySessionId = sessionId
  memoryLastActivity = activityMs

  if (cookieDomain) {
    clearHostOnlyCookies()
  }

  setCookie(SESSION_COOKIE, sessionId, SESSION_COOKIE_MAX_AGE_SEC, cookieDomain)
  setCookie(
    ACTIVITY_COOKIE,
    String(activityMs),
    SESSION_COOKIE_MAX_AGE_SEC,
    cookieDomain
  )
  writeLs(SESSION_LS_KEY, sessionId)
  writeLs(ACTIVITY_LS_KEY, String(activityMs))
}

/**
 * Picks the first tier that holds a session id: cookie → localStorage → memory.
 * A missing/unparseable activity stamp yields `0`, which callers treat as "alive"
 * rather than expired — losing the stamp alone must not rotate a valid session.
 */
function readSessionPair(): {
  sessionId: string | null
  lastActivity: number
} {
  const cookieId = getCookie(SESSION_COOKIE)
  if (cookieId) {
    return {
      sessionId: cookieId,
      lastActivity: toTimestamp(getCookie(ACTIVITY_COOKIE)),
    }
  }

  const lsId = readLs(SESSION_LS_KEY)
  if (lsId) {
    return {
      sessionId: lsId,
      lastActivity: toTimestamp(readLs(ACTIVITY_LS_KEY)),
    }
  }

  if (memorySessionId) {
    return { sessionId: memorySessionId, lastActivity: memoryLastActivity }
  }

  return { sessionId: null, lastActivity: 0 }
}

export function getCurrentSessionId(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  try {
    const existingId =
      getCookie(SESSION_COOKIE) ?? readLs(SESSION_LS_KEY) ?? memorySessionId
    if (existingId && isValidUuidV4(existingId)) {
      return existingId
    }
  } catch {
    // ignore
  }
  return undefined
}

export function getOrCreateSessionId(
  optionsOrCustom?: SessionIdOptions | (() => string)
): string {
  const options: SessionIdOptions =
    typeof optionsOrCustom === 'function'
      ? { custom: optionsOrCustom }
      : optionsOrCustom ?? {}

  if (options.custom) {
    return options.custom()
  }

  if (typeof window === 'undefined') {
    return generateUuidV4()
  }

  const now = Date.now()

  try {
    const { sessionId: existingId, lastActivity } = readSessionPair()

    if (
      existingId &&
      isValidUuidV4(existingId) &&
      (lastActivity === 0 || now - lastActivity <= SESSION_INACTIVITY_MS)
    ) {
      touchSessionStorage(existingId, now, options.cookieDomain)
      return existingId
    }
  } catch {
    // fall through
  }

  const nextId = generateUuidV4()
  try {
    touchSessionStorage(nextId, now, options.cookieDomain)
  } catch {
    // storage unavailable
  }
  return nextId
}

/** Test-only: drops the in-memory tier so specs start from a clean slate. */
export function resetSessionMemory(): void {
  memorySessionId = null
  memoryLastActivity = 0
  hostOnlyCookiesCleared = false
}
