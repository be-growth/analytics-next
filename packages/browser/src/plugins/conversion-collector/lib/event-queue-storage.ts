import type { CollectEvent } from '../types'

/**
 * Legacy single-key queue, written by SDK versions before the per-tab split.
 * Still read once on boot so an upgrade does not strand a pending backlog; it
 * is never written again.
 */
export const EVENT_QUEUE_STORAGE_KEY = 'utua_event_queue'

/**
 * Each tab owns its own queue key.
 *
 * The previous design had every tab write the shared key with its own in-memory
 * queue, so the last writer silently erased whatever the other tab had pending
 * — the mutex below is best-effort and cannot prevent it. Partitioning by owner
 * removes the race at the source: a tab only ever overwrites its own events.
 * Cross-tab merging is not an option here, because a write also has to be able
 * to REMOVE delivered events; merging would resurrect them.
 */
const QUEUE_KEY_PREFIX = 'utua_event_queue::'

export const MAX_PERSISTED_EVENTS = 100
export const MAX_PERSISTED_BYTES = 1024 * 1024

/**
 * A queue whose owner has not written for this long is treated as abandoned
 * (tab closed or crashed) and adopted by whichever tab boots next. Generous on
 * purpose: adopting a queue that is merely idle produces duplicates, which the
 * worker's message_id dedup absorbs, while adopting too late produces nothing
 * worse than a delay.
 */
const ORPHAN_QUEUE_MS = 5 * 60 * 1000

/** Bound on how many abandoned queues a single boot will adopt. */
const MAX_ADOPTED_QUEUES = 20

// Deliberately not under QUEUE_KEY_PREFIX: the prefix scan must not see it.
const QUEUE_MUTEX_KEY = 'utua_event_queue_lock'
const LOCK_TIMEOUT_MS = 50
const MAX_LOCK_ATTEMPTS = 3
const TAB_LOCK_OWNER = `${Date.now()}-${Math.random()}`
const TAB_QUEUE_KEY = `${QUEUE_KEY_PREFIX}${TAB_LOCK_OWNER}`

/** Storage key this tab persists to. Exposed for tests and diagnostics. */
export function getTabQueueStorageKey(): string {
  return TAB_QUEUE_KEY
}

type StorageLock = {
  expires: number
  owner: string
}

/** Envelope around a tab's queue. `updatedAt` is what makes orphans detectable. */
type PersistedQueue = {
  owner: string
  updatedAt: number
  events: CollectEvent[]
}

/**
 * Called when events are dropped by the size/count caps. This is silent data
 * loss otherwise — the host wires it to telemetry.
 */
let onTrim: ((dropped: CollectEvent[]) => void) | undefined

export function setQueueTrimHandler(
  handler: ((dropped: CollectEvent[]) => void) | undefined
): void {
  onTrim = handler
}

/**
 * Best-effort cross-tab mutex via localStorage. Not a true CAS lock — two tabs
 * can still race — but each tab only releases locks it owns. With per-tab keys
 * it now only guards orphan adoption, where a race costs a duplicate rather
 * than a lost event.
 *
 * The Web Locks API would be a real mutex, but it is Promise-based and the
 * unload path (`writePersistedEventQueueSync`) has to stay synchronous.
 */
function isBrowserStorageAvailable(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    const key = '__utua_storage_probe__'
    window.localStorage.setItem(key, '1')
    window.localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

function tryAcquireLock(now: number): boolean {
  const rawLock = window.localStorage.getItem(QUEUE_MUTEX_KEY)
  const lock = rawLock ? (JSON.parse(rawLock) as StorageLock) : null
  if (lock !== null && now <= lock.expires) {
    return false
  }
  window.localStorage.setItem(
    QUEUE_MUTEX_KEY,
    JSON.stringify({ expires: now + LOCK_TIMEOUT_MS, owner: TAB_LOCK_OWNER })
  )
  return true
}

function releaseOwnedLock(): void {
  const rawLock = window.localStorage.getItem(QUEUE_MUTEX_KEY)
  if (!rawLock) {
    return
  }
  try {
    const lock = JSON.parse(rawLock) as StorageLock
    if (lock.owner === TAB_LOCK_OWNER) {
      window.localStorage.removeItem(QUEUE_MUTEX_KEY)
    }
  } catch {
    // ignore malformed lock
  }
}

function withStorageMutex(fn: () => void, attempt = 0): void {
  if (!isBrowserStorageAvailable()) {
    fn()
    return
  }

  const now = Date.now()
  if (tryAcquireLock(now)) {
    try {
      fn()
    } finally {
      releaseOwnedLock()
    }
    return
  }

  if (attempt < MAX_LOCK_ATTEMPTS) {
    setTimeout(() => withStorageMutex(fn, attempt + 1), LOCK_TIMEOUT_MS)
  } else {
    console.warn('[utua] queue lock timeout')
    fn()
  }
}

function isValidCollectEvent(value: unknown): value is CollectEvent {
  if (!value || typeof value !== 'object') {
    return false
  }
  const event = value as CollectEvent
  const type = event.type
  if (
    type !== 'track' &&
    type !== 'page' &&
    type !== 'identify' &&
    type !== 'screen'
  ) {
    return false
  }
  return (
    typeof event.messageId === 'string' &&
    typeof event.anonymousId === 'string' &&
    typeof event.timestamp === 'string'
  )
}

/**
 * Enforces the count and byte caps, dropping from the TAIL.
 *
 * The queue is consumed FIFO from the head, so the head holds the oldest
 * undelivered events — including the entry `page` that carries the campaign
 * attribution for the whole session. The previous `slice(-MAX)` kept the newest
 * and discarded exactly those.
 */
function trimQueue(events: CollectEvent[]): CollectEvent[] {
  let trimmed =
    events.length > MAX_PERSISTED_EVENTS
      ? events.slice(0, MAX_PERSISTED_EVENTS)
      : events

  while (trimmed.length > 0) {
    if (JSON.stringify(trimmed).length <= MAX_PERSISTED_BYTES) {
      break
    }
    trimmed = trimmed.slice(0, -1)
  }

  if (trimmed.length < events.length) {
    const dropped = events.slice(trimmed.length)
    console.warn(
      `[utua] dropped ${dropped.length} queued event(s): persistence cap`
    )
    onTrim?.(dropped)
  }

  return trimmed
}

function writeQueueToStorage(events: CollectEvent[]): void {
  if (!isBrowserStorageAvailable()) {
    return
  }

  try {
    if (events.length === 0) {
      window.localStorage.removeItem(TAB_QUEUE_KEY)
      return
    }

    const trimmed = trimQueue(events)
    if (trimmed.length === 0) {
      window.localStorage.removeItem(TAB_QUEUE_KEY)
      return
    }

    const payload: PersistedQueue = {
      owner: TAB_LOCK_OWNER,
      updatedAt: Date.now(),
      events: trimmed,
    }
    window.localStorage.setItem(TAB_QUEUE_KEY, JSON.stringify(payload))
  } catch {
    // Quota exceeded or storage blocked — drop persistence silently.
  }
}

/** Accepts both the per-tab envelope and the legacy bare array. */
function parseStoredQueue(raw: string | null): PersistedQueue | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown

    if (Array.isArray(parsed)) {
      return {
        owner: '',
        updatedAt: 0,
        events: parsed.filter(isValidCollectEvent),
      }
    }

    if (parsed && typeof parsed === 'object') {
      const envelope = parsed as Partial<PersistedQueue>
      if (!Array.isArray(envelope.events)) {
        return null
      }
      return {
        owner: typeof envelope.owner === 'string' ? envelope.owner : '',
        updatedAt:
          typeof envelope.updatedAt === 'number' ? envelope.updatedAt : 0,
        events: envelope.events.filter(isValidCollectEvent),
      }
    }
  } catch {
    // fall through
  }
  return null
}

function queueKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key && key.startsWith(QUEUE_KEY_PREFIX)) {
      keys.push(key)
    }
  }
  return keys
}

/**
 * Reads this tab's queue, then adopts anything left behind by tabs that are
 * gone — including the pre-split legacy key. Adopted keys are removed so a
 * third tab does not pick them up again.
 *
 * Order matters: this tab's own events come first, and adopted ones are
 * appended, so the local FIFO ordering survives. Events are deduped by
 * messageId, since the same backlog can legitimately appear twice.
 */
function collectQueues(): CollectEvent[] {
  const own = parseStoredQueue(window.localStorage.getItem(TAB_QUEUE_KEY))
  const result: CollectEvent[] = own ? [...own.events] : []
  const seen = new Set(result.map((event) => event.messageId))

  const now = Date.now()
  const adoptable: string[] = [EVENT_QUEUE_STORAGE_KEY]
  for (const key of queueKeys()) {
    if (key !== TAB_QUEUE_KEY) {
      adoptable.push(key)
    }
  }

  let adopted = 0
  for (const key of adoptable) {
    if (adopted >= MAX_ADOPTED_QUEUES) {
      break
    }
    const stored = parseStoredQueue(window.localStorage.getItem(key))
    if (!stored) {
      continue
    }
    // A live tab's queue is left alone; only abandoned ones are taken over.
    // The legacy key has updatedAt = 0, so it is always adoptable.
    if (stored.updatedAt !== 0 && now - stored.updatedAt < ORPHAN_QUEUE_MS) {
      continue
    }

    adopted += 1
    try {
      window.localStorage.removeItem(key)
    } catch {
      // storage blocked — the events are still adopted in memory
    }
    for (const event of stored.events) {
      if (event.messageId != null && seen.has(event.messageId)) {
        continue
      }
      if (event.messageId != null) {
        seen.add(event.messageId)
      }
      result.push(event)
    }
  }

  return result
}

export function readPersistedEventQueue(): CollectEvent[] {
  if (!isBrowserStorageAvailable()) {
    return []
  }

  let result: CollectEvent[] = []
  withStorageMutex(() => {
    try {
      result = collectQueues()
    } catch {
      result = []
    }
  })
  return result
}

export function writePersistedEventQueue(events: CollectEvent[]): void {
  if (!isBrowserStorageAvailable()) {
    return
  }

  // No mutex: this tab is the only writer of its own key.
  writeQueueToStorage(events)
}

/** Synchronous write for page unload — avoids deferred mutex retries. */
export function writePersistedEventQueueSync(events: CollectEvent[]): void {
  writePersistedEventQueue(events)
}

export function clearPersistedEventQueue(): void {
  if (!isBrowserStorageAvailable()) {
    return
  }

  withStorageMutex(() => {
    try {
      window.localStorage.removeItem(TAB_QUEUE_KEY)
      window.localStorage.removeItem(EVENT_QUEUE_STORAGE_KEY)
    } catch {
      // ignore
    }
  })
}
