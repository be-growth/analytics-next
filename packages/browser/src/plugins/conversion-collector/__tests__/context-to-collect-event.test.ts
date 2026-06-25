import { Context } from '../../../core/context'
import { contextToCollectEvent } from '../context-to-collect-event'

describe('contextToCollectEvent', () => {
  it('snapshots nested collect fields before later event mutations', () => {
    const ctx = new Context({
      type: 'track',
      event: 'Nested Event',
      properties: {
        nested: { value: 'before' },
        items: [{ id: 'item-1' }],
      },
      context: {
        campaign: { source: 'google' },
      },
      integrations: {
        Destination: { enabled: true },
      },
      _metadata: {
        bundled: ['collector'],
      },
    })

    const collectEvent = contextToCollectEvent(ctx, {} as never)

    ;(ctx.event.properties?.nested as { value: string }).value = 'after'
    ;(ctx.event.properties?.items as Array<{ id: string }>)[0]!.id = 'item-2'
    ;(ctx.event.context?.campaign as { source: string }).source = 'email'
    ;(ctx.event.integrations?.Destination as { enabled: boolean }).enabled =
      false
    ctx.event._metadata?.bundled?.push('mutated')

    expect(collectEvent?.properties).toEqual({
      nested: { value: 'before' },
      items: [{ id: 'item-1' }],
    })
    expect(collectEvent?.context).toEqual({
      campaign: { source: 'google' },
    })
    expect(collectEvent?.integrations).toEqual({
      Destination: { enabled: true },
    })
    expect(collectEvent?._metadata).toEqual({ bundled: ['collector'] })
  })
})
