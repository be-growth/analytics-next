---
'@segment/analytics-next': patch
---

fix(conversion-collector): stop losing events to a stalled or dead delivery queue

Four defects could each drop every event from a browser, not just a percentage of them:

- a non-retryable response (4xx) left the batch at the head of the queue forever, so a single 400/403/413 — a WAF rule, an expired token, an oversized payload — ended collection for that browser permanently, surviving reloads because the queue is persisted. Rejected batches are now discarded and reported through the new `onDrop` callback, and a retry ceiling (`maxEventRetries`, default 10) keeps a repeatedly failing batch from blocking the queue behind it.
- `flushAll` stopped the flush interval, but it also runs on `visibilitychange -> hidden`, which fires on a plain tab switch. After the first time the user switched away, the periodic flush never ran again. `stop()` now belongs to the plugin's `unload()`, and `visibilitychange -> visible` / `pageshow` re-arm the buffer.
- every tab wrote the same `localStorage` key with its own in-memory queue, so the last writer erased whatever the other tab had pending. Each tab now owns its queue key; queues left by tabs that are gone are adopted on boot, and the pre-split key is migrated.
- the persistence cap trimmed the newest events but the queue drains from the head, so what it actually discarded were the oldest undelivered events — including the entry `page` carrying the campaign attribution. It now trims from the tail and reports what it dropped.

Also: the unload payload is split into batches within the 64 KB limit that `sendBeacon` and `fetch({keepalive})` both impose (one oversized body was silently failing), the queue drains fully after a successful send instead of one batch per tick, and a failed flush no longer surfaces as an unhandled rejection.
