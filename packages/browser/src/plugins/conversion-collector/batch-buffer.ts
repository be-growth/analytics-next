import type { CollectDropReason, CollectEvent } from './types'
import {
  readPersistedEventQueue,
  writePersistedEventQueue,
  writePersistedEventQueueSync,
} from './lib/event-queue-storage'
import {
  BEACON_PAYLOAD_LIMIT_BYTES,
  buildCollectRequestBody,
  CollectDeliveryError,
  deliverCollectPayload,
  sendCollectViaBeacon,
  sendEventsToCollect,
  type CollectSendConfig,
} from './send-events'

/**
 * Why a batch left the queue without reaching the collector.
 *
 * `rejected` — the collector answered with a non-retryable status (4xx).
 * `retry_exhausted` — the batch failed `maxEventRetries` times in a row.
 */
/**
 * Retryable failures bump `_retryCount` and keep the batch at the head of the
 * queue. Without a ceiling, a batch that always fails blocks every event behind
 * it forever, so past this many attempts the batch is dropped and the queue
 * moves on.
 */
export const DEFAULT_MAX_EVENT_RETRIES = 10

export interface BatchBufferConfig extends CollectSendConfig {
  flushIntervalMs: number
  batchSize: number
  /** Attempts a batch gets before it is dropped. Defaults to {@link DEFAULT_MAX_EVENT_RETRIES}. */
  maxEventRetries?: number
  /**
   * Called whenever events are discarded without being delivered. The only
   * place the pipeline can observe browser-side loss — wire it to whatever
   * telemetry the host has.
   */
  onDrop?: (events: CollectEvent[], reason: CollectDropReason) => void
}

function incrementRetryCount(event: CollectEvent): CollectEvent {
  const retryCount = (event._retryCount ?? 0) + 1
  return { ...event, _retryCount: retryCount }
}

/** Serialized size in bytes — what the transport limits actually measure. */
function byteLength(body: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(body).length
  }
  if (typeof Blob !== 'undefined') {
    return new Blob([body]).size
  }
  return body.length
}

export class BatchBuffer {
  private queue: CollectEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flushSequence: Promise<void> = Promise.resolve()

  constructor(private readonly config: BatchBufferConfig) {
    this.hydrateFromStorage()
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      this.scheduleFlush()
    }, this.config.flushIntervalMs)
    this.scheduleFlush()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** True while the periodic flush is running — lets callers re-arm it. */
  isRunning(): boolean {
    return this.timer !== null
  }

  enqueue(event: CollectEvent): void {
    this.queue.push(event)
    this.persistQueue()
    if (this.queue.length >= this.config.batchSize) {
      this.scheduleFlush()
    }
  }

  getSize(): number {
    return this.queue.length
  }

  /**
   * Fire-and-forget flush. `flush()` rejects on delivery failure, and an
   * unhandled rejection inside setInterval is both noisy and easy to mistake
   * for a crash — failures are already retried on the next tick, so they are
   * reported and swallowed here.
   */
  private scheduleFlush(): void {
    this.flush().catch((error: unknown) => {
      console.warn('[utua] collect flush failed:', error)
    })
  }

  private hydrateFromStorage(): void {
    const persisted = readPersistedEventQueue()
    if (persisted.length > 0) {
      this.queue = [...persisted, ...this.queue]
      this.persistQueue()
    }
  }

  private persistQueue(): void {
    writePersistedEventQueue(this.queue)
  }

  private persistQueueSync(): void {
    writePersistedEventQueueSync(this.queue)
  }

  private persist(sync: boolean): void {
    if (sync) {
      this.persistQueueSync()
    } else {
      this.persistQueue()
    }
  }

  private peekBatch(maxSize = this.config.batchSize): CollectEvent[] {
    return this.queue.slice(0, maxSize)
  }

  /**
   * Serialize every delivery path, including unload flushes. A boolean lock is
   * not enough because flushAll() can otherwise start while flush() is waiting
   * on the network.
   */
  private withFlushLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.flushSequence
    let release!: () => void
    this.flushSequence = new Promise<void>((resolve) => {
      release = resolve
    })

    return previous.then(operation).finally(release)
  }

  private removeBatch(count: number): void {
    this.queue.splice(0, count)
  }

  /**
   * Removes a batch that will never be delivered, so the events behind it can
   * move. Dropping is deliberate: leaving a rejected batch at the head of a
   * localStorage-backed queue stalls the browser permanently, across reloads.
   */
  private discardBatch(
    count: number,
    reason: CollectDropReason,
    sync: boolean
  ): void {
    const dropped = this.queue.splice(0, count)
    this.persist(sync)
    if (dropped.length === 0) {
      return
    }
    console.warn(`[utua] dropped ${dropped.length} collect event(s): ${reason}`)
    this.config.onDrop?.(dropped, reason)
  }

  private get maxEventRetries(): number {
    return this.config.maxEventRetries ?? DEFAULT_MAX_EVENT_RETRIES
  }

  /**
   * Bumps the attempt counter on a failed batch and drops whatever exhausted
   * its retries.
   */
  private bumpRetryInPlace(count: number, sync = false): void {
    for (let i = 0; i < count && i < this.queue.length; i += 1) {
      this.queue[i] = incrementRetryCount(this.queue[i]!)
    }

    let exhausted = 0
    while (
      exhausted < this.queue.length &&
      (this.queue[exhausted]!._retryCount ?? 0) >= this.maxEventRetries
    ) {
      exhausted += 1
    }

    if (exhausted > 0) {
      this.discardBatch(exhausted, 'retry_exhausted', sync)
      return
    }

    this.persist(sync)
  }

  /**
   * Largest prefix of the queue whose serialized body stays within `maxBytes`.
   *
   * Both unload transports cap the payload at 64 KB — `sendBeacon` refuses a
   * larger blob outright, and `fetch` with `keepalive` is bound by the same
   * limit in the spec. Sending the whole queue as one body (the previous
   * behavior) therefore lost every large backlog at unload.
   *
   * Never returns an empty batch: a single oversized event is handed to the
   * transport on its own, and the transport decides.
   */
  private peekBatchWithinBytes(maxBytes: number): {
    batch: CollectEvent[]
    body: string
  } {
    const full = this.peekBatch(this.queue.length)
    const fullBody = buildCollectRequestBody(full)
    if (full.length <= 1 || byteLength(fullBody) <= maxBytes) {
      return { batch: full, body: fullBody }
    }

    const head = full.slice(0, 1)
    let best = { batch: head, body: buildCollectRequestBody(head) }
    let lo = 2
    let hi = full.length - 1

    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const candidate = full.slice(0, mid)
      const body = buildCollectRequestBody(candidate)
      if (byteLength(body) <= maxBytes) {
        best = { batch: candidate, body }
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    return best
  }

  async flush(): Promise<void> {
    return this.withFlushLock(() => this.flushLocked())
  }

  private async flushLocked(): Promise<void> {
    if (this.queue.length === 0) {
      return
    }

    const batch = this.peekBatch()
    const batchSize = batch.length
    let delivered = false

    try {
      await sendEventsToCollect(batch, this.config)
      this.removeBatch(batchSize)
      this.persistQueue()
      delivered = true
    } catch (error) {
      if (error instanceof CollectDeliveryError && !error.retryable) {
        // A 4xx will fail identically forever. Keeping the batch would stall
        // every event behind it — including across reloads, since the queue is
        // persisted — so it is dropped and counted.
        this.discardBatch(batchSize, 'rejected', false)
        throw error
      }
      this.bumpRetryInPlace(batchSize)
      throw error
    } finally {
      // Drain the whole backlog instead of one batch per interval tick — but
      // only after a successful send. Chaining after a failure would retry as
      // fast as the event loop allows, and against an endpoint rejecting
      // everything it would empty the queue in one burst of doomed requests.
      // A failed batch waits for the next tick.
      if (delivered && this.queue.length > 0) {
        this.scheduleFlush()
      }
    }
  }

  /**
   * Drains the queue. Uses sendBeacon on unload when the payload fits; otherwise keepalive fetch.
   *
   * Deliberately does NOT stop the interval: this also runs on
   * `visibilitychange -> hidden`, which fires when the user merely switches
   * tabs. Stopping here left the periodic flush dead for the rest of the page's
   * life. The plugin's `unload()` owns `stop()`.
   */
  async flushAll(options?: { unload?: boolean }): Promise<void> {
    return this.withFlushLock(() => this.flushAllLocked(options))
  }

  private async flushAllLocked(options?: { unload?: boolean }): Promise<void> {
    const syncPersist = options?.unload === true

    while (this.queue.length > 0) {
      const { batch, body } = options?.unload
        ? this.peekBatchWithinBytes(BEACON_PAYLOAD_LIMIT_BYTES)
        : { batch: this.peekBatch(this.queue.length), body: '' }
      const batchSize = batch.length

      // A single event cannot be delivered through either unload transport
      // when its serialized body exceeds the browser keepalive limit. Drop
      // only that event so smaller events behind it can still be delivered.
      if (
        options?.unload &&
        batch.length === 1 &&
        byteLength(body) > BEACON_PAYLOAD_LIMIT_BYTES
      ) {
        this.discardBatch(1, 'oversized', syncPersist)
        continue
      }

      const onSuccess = () => {
        this.removeBatch(batchSize)
        this.persist(syncPersist)
      }

      const onFailure = (error: unknown) => {
        if (error instanceof CollectDeliveryError && !error.retryable) {
          this.discardBatch(batchSize, 'rejected', syncPersist)
          return
        }
        this.bumpRetryInPlace(batchSize, syncPersist)
      }

      if (options?.unload) {
        if (sendCollectViaBeacon(this.config.endpoint, body)) {
          onSuccess()
          continue
        }

        try {
          await deliverCollectPayload(body, this.config, { keepalive: true })
          onSuccess()
          continue
        } catch (error) {
          onFailure(error)
          throw error
        }
      }

      try {
        await sendEventsToCollect(batch, this.config)
        onSuccess()
      } catch (error) {
        onFailure(error)
        throw error
      }
    }
  }
}
