import { BatchBuffer } from '../batch-buffer'
import { getTabQueueStorageKey } from '../lib/event-queue-storage'
import type { CollectEvent } from '../types'

const EVENT_QUEUE_STORAGE_KEY = getTabQueueStorageKey()

const endpoint = 'https://collector.test/events'

const sampleEvent = (overrides: Partial<CollectEvent> = {}): CollectEvent => ({
  type: 'track',
  event: 'test_event',
  anonymousId: '550e8400-e29b-41d4-a716-446655440001',
  context: {},
  messageId: '550e8400-e29b-41d4-a716-446655440002',
  originalTimestamp: '2026-03-23T12:00:00.000Z',
  timestamp: '2026-03-23T12:00:00.000Z',
  ...overrides,
})

function createBuffer(): BatchBuffer {
  return new BatchBuffer({
    endpoint,
    retryAttempts: 0,
    flushIntervalMs: 60_000,
    batchSize: 10,
  })
}

describe('BatchBuffer resilient transport', () => {
  beforeEach(() => {
    window.localStorage.clear()
    jest.restoreAllMocks()
  })

  it('persists offline queue across a new buffer instance', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'))

    const first = createBuffer()
    first.enqueue(sampleEvent())

    await expect(first.flush()).rejects.toMatchObject({ retryable: true })
    expect(window.localStorage.getItem(EVENT_QUEUE_STORAGE_KEY)).toContain(
      'test_event'
    )

    const second = createBuffer()
    expect(second.getSize()).toBe(1)
  })

  it('treats successful sendBeacon on unload as delivered', async () => {
    const fetchMock = jest.fn()
    global.fetch = fetchMock
    const beaconMock = jest.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beaconMock,
      configurable: true,
    })

    const buffer = createBuffer()
    buffer.enqueue(sampleEvent())

    await buffer.flushAll({ unload: true })

    expect(beaconMock).toHaveBeenCalledWith(endpoint, expect.any(Blob))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(buffer.getSize()).toBe(0)
    expect(window.localStorage.getItem(EVENT_QUEUE_STORAGE_KEY)).toBeNull()
  })

  it('falls back to keepalive fetch when unload payload is over the beacon limit', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    })
    global.fetch = fetchMock
    const beaconMock = jest.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beaconMock,
      configurable: true,
    })

    const buffer = createBuffer()
    buffer.enqueue(
      sampleEvent({ properties: { payload: 'x'.repeat(70 * 1024) } })
    )

    await buffer.flushAll({ unload: true })

    expect(beaconMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({ keepalive: true })
    )
    expect(buffer.getSize()).toBe(0)
  })

  it('splits the unload payload into batches within the beacon limit', async () => {
    const sent: Blob[] = []
    const beaconMock = jest.fn((_url: string, blob: Blob) => {
      sent.push(blob)
      return true
    })
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beaconMock,
      configurable: true,
    })
    global.fetch = jest.fn()

    const buffer = createBuffer()
    // 6 x ~20KB: one body would be ~120KB, over the 64KB cap both transports share.
    for (let i = 0; i < 6; i += 1) {
      buffer.enqueue(
        sampleEvent({
          messageId: `msg-${i}`,
          properties: { payload: 'x'.repeat(20 * 1024) },
        })
      )
    }

    await buffer.flushAll({ unload: true })

    expect(beaconMock.mock.calls.length).toBeGreaterThan(1)
    for (const blob of sent) {
      expect(blob.size).toBeLessThanOrEqual(64 * 1024)
    }
    expect(buffer.getSize()).toBe(0)
  })

  it('drops a rejected batch so the queue keeps draining (P0-1)', async () => {
    // A 4xx fails identically forever. Keeping the batch at the head of a
    // persisted queue used to stall the browser permanently, across reloads.
    const onDrop = jest.fn()
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
    })

    const buffer = new BatchBuffer({
      endpoint,
      retryAttempts: 0,
      flushIntervalMs: 60_000,
      batchSize: 10,
      onDrop,
    })
    buffer.enqueue(sampleEvent({ messageId: 'poison' }))

    await expect(buffer.flush()).rejects.toMatchObject({ retryable: false })

    expect(buffer.getSize()).toBe(0)
    expect(onDrop).toHaveBeenCalledWith(
      [expect.objectContaining({ messageId: 'poison' })],
      'rejected'
    )

    // The queue is usable again — the old code could never reach this point.
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, headers: new Headers() })
    buffer.enqueue(sampleEvent({ messageId: 'healthy' }))
    await buffer.flush()
    expect(buffer.getSize()).toBe(0)
  })

  it('drops a batch that exhausts its retries instead of blocking the queue', async () => {
    const onDrop = jest.fn()
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'))

    const buffer = new BatchBuffer({
      endpoint,
      retryAttempts: 0,
      flushIntervalMs: 60_000,
      batchSize: 10,
      maxEventRetries: 3,
      onDrop,
    })
    buffer.enqueue(sampleEvent({ messageId: 'stuck' }))

    for (let i = 0; i < 3; i += 1) {
      await expect(buffer.flush()).rejects.toMatchObject({ retryable: true })
    }

    expect(onDrop).toHaveBeenCalledWith(
      [expect.objectContaining({ messageId: 'stuck' })],
      'retry_exhausted'
    )
    expect(buffer.getSize()).toBe(0)
  })

  it('keeps the periodic flush alive across a flushAll (P0-2)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, headers: new Headers() })
    Object.defineProperty(navigator, 'sendBeacon', {
      value: jest.fn(() => true),
      configurable: true,
    })

    const buffer = createBuffer()
    buffer.start()
    expect(buffer.isRunning()).toBe(true)

    // `visibilitychange -> hidden` fires on a plain tab switch, not only on
    // navigation, so the timer has to survive it.
    await buffer.flushAll({ unload: true })

    expect(buffer.isRunning()).toBe(true)
    buffer.stop()
  })

  it('serializes normal and unload flushes', async () => {
    let releaseFetch!: (response: Response) => void
    const fetchMock = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve
        })
    )
    global.fetch = fetchMock as typeof fetch
    const beaconMock = jest.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beaconMock,
      configurable: true,
    })

    const buffer = createBuffer()
    buffer.enqueue(sampleEvent({ messageId: 'normal' }))
    const normalFlush = buffer.flush()

    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    buffer.enqueue(sampleEvent({ messageId: 'unload' }))
    const unloadFlush = buffer.flushAll({ unload: true })

    expect(beaconMock).not.toHaveBeenCalled()

    releaseFetch({ ok: true, status: 200, headers: new Headers() } as Response)
    await normalFlush
    await unloadFlush

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(beaconMock).toHaveBeenCalledTimes(1)
    expect(buffer.getSize()).toBe(0)
  })
})
