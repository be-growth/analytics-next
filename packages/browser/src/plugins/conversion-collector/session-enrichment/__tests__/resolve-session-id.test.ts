import { isValidUuidV4 } from '../../lib/uuid'
import type { ConversionCollectorSettings } from '../../types'
import { resolveSessionId } from '../resolve-session-id'
import { resetSessionMemory } from '../session-manager'

const baseSettings: ConversionCollectorSettings = { endpoint: '/collector' }

describe('resolveSessionId', () => {
  beforeEach(() => {
    resetSessionMemory()
    window.localStorage.clear()
  })

  it('uses the host override when it is a valid uuid v4', () => {
    const override = '660e8400-e29b-41d4-a716-446655440000'
    const resolved = resolveSessionId({
      ...baseSettings,
      getSessionId: () => override,
    })
    expect(resolved).toBe(override)
  })

  it.each([
    ['empty string', ''],
    ['legacy id', 'session-42'],
    ['uuid v1', 'f47ac10b-58cc-11e4-8f1e-0800200c9a66'],
  ])('falls back to the cookie-backed session for %s', (_label, value) => {
    const onInvalid = jest.fn()
    const resolved = resolveSessionId(
      { ...baseSettings, getSessionId: () => value },
      onInvalid
    )

    expect(resolved).not.toBe(value)
    expect(isValidUuidV4(resolved)).toBe(true)
    // An empty override is indistinguishable from "no override", so it is not reported.
    expect(onInvalid).toHaveBeenCalledTimes(value === '' ? 0 : 1)
  })

  it('reports the rejected value so the host can debug it', () => {
    const onInvalid = jest.fn()
    resolveSessionId(
      { ...baseSettings, getSessionId: () => 'session-42' },
      onInvalid
    )
    expect(onInvalid).toHaveBeenCalledWith('session-42')
  })

  it('generates a session when no override is configured', () => {
    expect(isValidUuidV4(resolveSessionId(baseSettings))).toBe(true)
  })
})
