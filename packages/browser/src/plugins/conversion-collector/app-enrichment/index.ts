import { PluginType } from '@segment/analytics-core'
import { version } from '../../../generated/version'
import { Context } from '../../../core/context'
import { Plugin } from '../../../core/plugin'
import type { ConversionCollectorSettings } from '../types'

const SDK_LIBRARY_NAME = 'conversion-analytics-sdk'

/**
 * Always-on enrichment: stamps `context.app.name` (from settings.appName) and
 * `context.library.{name,version}` on every event of the native pipeline.
 *
 * These used to be emitted only by `conversionContextEnrichment`, which is
 * opt-in (`enableContextEnrichment`) AND overwrites `anonymousId` — so with the
 * flag off (the default) both `app_name` and `sdk_version` never left the
 * browser (AU-165). This plugin fills that gap without touching `anonymousId`.
 */
export function appEnrichment(settings: ConversionCollectorSettings): Plugin {
  const enrich = (ctx: Context): Context => {
    const evtCtx = ctx.event.context ?? {}
    const nextCtx: Record<string, unknown> = {
      ...evtCtx,
      library: { name: SDK_LIBRARY_NAME, version },
    }

    if (settings.appName) {
      nextCtx.app = { name: settings.appName }
    }

    ctx.updateEvent('context', nextCtx)
    return ctx
  }

  return {
    name: 'app-enrichment',
    type: 'enrichment' as PluginType,
    version: '0.1.0',
    isLoaded: () => true,
    load: () => Promise.resolve(),
    track: enrich,
    identify: enrich,
    page: enrich,
    screen: enrich,
    alias: enrich,
    group: enrich,
  }
}
