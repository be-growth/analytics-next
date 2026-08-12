import { PluginType } from '@segment/analytics-core'
import { Context } from '../../../core/context'
import { Plugin } from '../../../core/plugin'
import type { ConversionCollectorSettings } from '../types'
import { resolveSessionId } from './resolve-session-id'

export function sessionEnrichment(
  settings: ConversionCollectorSettings
): Plugin {
  const enrich = (ctx: Context): Context => {
    const currentSessionId = resolveSessionId(settings, (received) =>
      ctx.log('warn', 'getSessionId returned an invalid session id', {
        received,
      })
    )

    const evtCtx = ctx.event.context ?? {}
    ctx.updateEvent('context', {
      ...evtCtx,
      sessionId: currentSessionId,
    })

    return ctx
  }

  return {
    name: 'session-enrichment',
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

export { resolveSessionId } from './resolve-session-id'
export { getOrCreateSessionId } from './session-manager'
export {
  SESSION_COOKIE,
  ACTIVITY_COOKIE,
  SESSION_INACTIVITY_MS,
  resetSessionMemory,
} from './session-manager'
