import type { CollectEvent } from '../../types'
import {
  clearPersistedEventQueue,
  EVENT_QUEUE_STORAGE_KEY,
  getTabQueueStorageKey,
  MAX_PERSISTED_EVENTS,
  readPersistedEventQueue,
  TAB_OWNER_STORAGE_KEY,
  writePersistedEventQueue,
} from '../event-queue-storage'

const TAB_QUEUE_KEY = getTabQueueStorageKey()

const sampleEvent = (id: string): CollectEvent => ({
  type: 'track',
  event: 'test',
  anonymousId: '550e8400-e29b-41d4-a716-446655440001',
  context: {},
  messageId: id,
  originalTimestamp: '2026-03-23T12:00:00.000Z',
  timestamp: '2026-03-23T12:00:00.000Z',
})

describe('event-queue-storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    clearPersistedEventQueue()
  })

  it('returns an empty queue when storage is empty', () => {
    expect(readPersistedEventQueue()).toEqual([])
  })

  it('persists and reads events', () => {
    const events = [sampleEvent('1'), sampleEvent('2')]
    writePersistedEventQueue(events)
    expect(readPersistedEventQueue()).toEqual(events)
  })

  it('uses a stable owner across reloads in the same tab', () => {
    const owner = window.sessionStorage.getItem(TAB_OWNER_STORAGE_KEY)

    expect(owner).toBeTruthy()
    expect(getTabQueueStorageKey()).toBe(`utua_event_queue::${owner}`)
  })

  it('clears storage when queue is empty', () => {
    writePersistedEventQueue([sampleEvent('1')])
    writePersistedEventQueue([])
    expect(window.localStorage.getItem(TAB_QUEUE_KEY)).toBeNull()
    expect(readPersistedEventQueue()).toEqual([])
  })

  it('keeps the OLDEST events when over the max count', () => {
    // The queue drains FIFO from the head, so the head holds the events that
    // are next on the wire — including the entry `page` carrying the campaign
    // attribution. Trimming has to drop from the tail.
    const events = Array.from(
      { length: MAX_PERSISTED_EVENTS + 5 },
      (_, index) => sampleEvent(String(index))
    )
    writePersistedEventQueue(events)
    const persisted = readPersistedEventQueue()
    expect(persisted).toHaveLength(MAX_PERSISTED_EVENTS)
    expect(persisted[0]?.messageId).toBe('0')
    expect(persisted[persisted.length - 1]?.messageId).toBe(
      String(MAX_PERSISTED_EVENTS - 1)
    )
  })

  it('drops an oversized head but preserves later events', () => {
    const oversized = sampleEvent('oversized')
    oversized.properties = { payload: 'x'.repeat(2 * 1024 * 1024) }

    writePersistedEventQueue([oversized, sampleEvent('later')])

    expect(readPersistedEventQueue().map((event) => event.messageId)).toEqual([
      'later',
    ])
  })

  it('ignores invalid persisted payloads', () => {
    window.localStorage.setItem(
      TAB_QUEUE_KEY,
      JSON.stringify([{ type: 'bad' }])
    )
    expect(readPersistedEventQueue()).toEqual([])
  })

  it('does not overwrite another tab that is still alive', () => {
    // The pre-split design had both tabs write one shared key, so whichever
    // wrote last erased the other's pending events.
    const otherTabKey = 'utua_event_queue::other-tab'
    window.localStorage.setItem(
      otherTabKey,
      JSON.stringify({
        owner: 'other-tab',
        updatedAt: Date.now(),
        events: [sampleEvent('from-other-tab')],
      })
    )

    writePersistedEventQueue([sampleEvent('mine')])

    const otherTab = JSON.parse(window.localStorage.getItem(otherTabKey)!)
    expect(otherTab.events).toHaveLength(1)
    expect(readPersistedEventQueue().map((e) => e.messageId)).toEqual(['mine'])
  })

  it('adopts the queue of a tab that is gone', () => {
    window.localStorage.setItem(
      'utua_event_queue::dead-tab',
      JSON.stringify({
        owner: 'dead-tab',
        updatedAt: Date.now() - 10 * 60 * 1000,
        events: [sampleEvent('orphan')],
      })
    )

    writePersistedEventQueue([sampleEvent('mine')])

    expect(readPersistedEventQueue().map((e) => e.messageId)).toEqual([
      'mine',
      'orphan',
    ])
    expect(window.localStorage.getItem('utua_event_queue::dead-tab')).toBeNull()
  })

  it('migrates a backlog left by the pre-split single-key version', () => {
    window.localStorage.setItem(
      EVENT_QUEUE_STORAGE_KEY,
      JSON.stringify([sampleEvent('legacy')])
    )

    expect(readPersistedEventQueue().map((e) => e.messageId)).toEqual([
      'legacy',
    ])
    expect(window.localStorage.getItem(EVENT_QUEUE_STORAGE_KEY)).toBeNull()
  })
})
