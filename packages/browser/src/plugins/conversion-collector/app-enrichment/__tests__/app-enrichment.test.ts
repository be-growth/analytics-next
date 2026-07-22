import { AnalyticsBrowser } from '../../../../browser'
import { envEnrichment } from '../../../env-enrichment'
import { conversionCdnSettingsMinimal, conversionPipelinePlugins } from '../..'
import { version } from '../../../../generated/version'

const COLLECTOR_ENDPOINT = 'https://collector.test/events'

type CollectedEvent = {
  type: string
  anonymousId: string
  context?: {
    app?: { name?: string }
    library?: { name?: string; version?: string }
  }
}

async function loadWithPipeline(appName?: string): Promise<{
  fetchMock: jest.Mock
  anonymousId: string
}> {
  const [analytics] = await AnalyticsBrowser.load(
    {
      writeKey: 'conversion-pipeline',
      cdnSettings: conversionCdnSettingsMinimal,
      plugins: [
        envEnrichment,
        ...conversionPipelinePlugins({
          endpoint: COLLECTOR_ENDPOINT,
          retryAttempts: 0,
          flushIntervalMs: 60_000,
          batchSize: 10,
          appName,
        }),
      ],
    },
    { integrations: { 'Segment.io': false } }
  )

  await analytics.track('quiz_started', { quizId: 'q1' })
  await analytics.track('quiz_completed', { quizId: 'q1' })

  // Deterministic flush: the collector flushes its batch when the page goes
  // hidden. Force sendBeacon to fail so it falls back to fetch (which we mock).
  Object.defineProperty(navigator, 'sendBeacon', {
    value: () => false,
    configurable: true,
  })
  Object.defineProperty(document, 'visibilityState', {
    value: 'hidden',
    configurable: true,
  })
  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    fetchMock: global.fetch as jest.Mock,
    anonymousId: analytics.user().anonymousId() as string,
  }
}

function bodyOf(fetchMock: jest.Mock): CollectedEvent[] {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return JSON.parse(String(init.body)) as CollectedEvent[]
}

describe('appEnrichment (native pipeline)', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    window.localStorage.clear()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('stamps context.app.name from settings.appName on every event', async () => {
    const { fetchMock } = await loadWithPipeline('strapi-quiz')
    const events = bodyOf(fetchMock)

    expect(events.length).toBeGreaterThan(0)
    for (const ev of events) {
      expect(ev.context?.app?.name).toBe('strapi-quiz')
    }
  })

  it('stamps context.library.{name,version} from the SDK build', async () => {
    const { fetchMock } = await loadWithPipeline('strapi-quiz')
    const [first] = bodyOf(fetchMock)

    expect(first.context?.library?.name).toBe('conversion-analytics-sdk')
    expect(first.context?.library?.version).toBe(version)
  })

  it('omits context.app when appName is not configured but still stamps library', async () => {
    const { fetchMock } = await loadWithPipeline(undefined)
    const [first] = bodyOf(fetchMock)

    expect(first.context?.app).toBeUndefined()
    expect(first.context?.library?.name).toBe('conversion-analytics-sdk')
  })

  it('does NOT overwrite anonymousId (no identity reset — AU-165 trap)', async () => {
    // A stale utua_anonymous_id must NOT be adopted: only the opt-in
    // conversionContextEnrichment reads it, and appEnrichment must not.
    window.localStorage.setItem('utua_anonymous_id', 'utua-should-not-be-used')

    const { fetchMock, anonymousId } = await loadWithPipeline('strapi-quiz')
    const events = bodyOf(fetchMock)

    expect(anonymousId).not.toBe('utua-should-not-be-used')
    for (const ev of events) {
      expect(ev.anonymousId).toBe(anonymousId)
      expect(ev.anonymousId).not.toBe('utua-should-not-be-used')
    }
  })
})
