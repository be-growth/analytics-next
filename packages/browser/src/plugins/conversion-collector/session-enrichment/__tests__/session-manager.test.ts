import { isValidUuidV4 } from '../../lib/uuid'
import {
  ACTIVITY_COOKIE,
  ACTIVITY_LS_KEY,
  getCurrentSessionId,
  getOrCreateSessionId,
  resetSessionMemory,
  SESSION_COOKIE,
  SESSION_INACTIVITY_MS,
  SESSION_LS_KEY,
} from '../session-manager'

const EXTERNAL_ID = '11111111-2222-4333-8444-555555555555'

const cookieDescriptor = Object.getOwnPropertyDescriptor(
  Document.prototype,
  'cookie'
)!

function clearStorage(): void {
  for (const name of [SESSION_COOKIE, ACTIVITY_COOKIE]) {
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`
  }
  window.localStorage.clear()
}

/** Simulates Safari private mode / CMP-blocked storage: every write is a no-op. */
function blockAllStorage(): () => void {
  const cookieJar: string[] = []
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookieJar.join('; '),
    set: () => undefined,
  })

  const localStorageDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'localStorage'
  )
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => {
      throw new Error('localStorage is not available')
    },
  })

  return () => {
    Object.defineProperty(document, 'cookie', cookieDescriptor)
    if (localStorageDescriptor) {
      Object.defineProperty(window, 'localStorage', localStorageDescriptor)
    }
  }
}

describe('session-manager', () => {
  beforeEach(() => {
    resetSessionMemory()
    clearStorage()
  })

  afterEach(() => {
    Object.defineProperty(document, 'cookie', cookieDescriptor)
  })

  it('reuses the session within the inactivity window', () => {
    const first = getOrCreateSessionId()
    expect(isValidUuidV4(first)).toBe(true)
    expect(getOrCreateSessionId()).toBe(first)
  })

  it('rotates after the inactivity window expires', () => {
    const first = getOrCreateSessionId()
    const stale = String(Date.now() - SESSION_INACTIVITY_MS - 1000)
    document.cookie = `${ACTIVITY_COOKIE}=${stale}; path=/; max-age=3600; SameSite=Lax`
    window.localStorage.setItem(ACTIVITY_LS_KEY, stale)

    const rotated = getOrCreateSessionId()
    expect(rotated).not.toBe(first)
    expect(isValidUuidV4(rotated)).toBe(true)
  })

  describe('storage blocked', () => {
    it('keeps a single session id across events instead of minting one per event', () => {
      const restore = blockAllStorage()
      try {
        const ids = Array.from({ length: 5 }, () => getOrCreateSessionId())
        expect(isValidUuidV4(ids[0]!)).toBe(true)
        expect(ids.every((id) => id === ids[0])).toBe(true)
      } finally {
        restore()
      }
    })

    it('exposes the in-memory session through getCurrentSessionId', () => {
      const restore = blockAllStorage()
      try {
        const created = getOrCreateSessionId()
        expect(getCurrentSessionId()).toBe(created)
      } finally {
        restore()
      }
    })
  })

  describe('missing activity stamp', () => {
    it('keeps a valid session id instead of rotating it', () => {
      const first = getOrCreateSessionId()
      document.cookie = `${ACTIVITY_COOKIE}=; path=/; max-age=0; SameSite=Lax`
      window.localStorage.removeItem(ACTIVITY_LS_KEY)
      resetSessionMemory()

      expect(getOrCreateSessionId()).toBe(first)
    })

    it('still rotates when the stored id is not a uuid v4', () => {
      document.cookie = `${SESSION_COOKIE}=legacy-session-42; path=/; max-age=3600; SameSite=Lax`

      const next = getOrCreateSessionId()
      expect(next).not.toBe('legacy-session-42')
      expect(isValidUuidV4(next)).toBe(true)
    })
  })

  describe('cookieDomain', () => {
    it('emits the session cookies scoped to the configured domain', () => {
      const writes: string[] = []
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          writes.push(value)
        },
      })

      getOrCreateSessionId({ cookieDomain: '.utua.work' })

      const sessionWrite = writes.find(
        (w) => w.startsWith(`${SESSION_COOKIE}=`) && !w.includes('max-age=0')
      )
      expect(sessionWrite).toContain('; domain=.utua.work')
    })

    it('drops the legacy host-only cookies once, after reading the current session', () => {
      const writes: string[] = []
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          writes.push(value)
        },
      })

      getOrCreateSessionId({ cookieDomain: '.utua.work' })
      getOrCreateSessionId({ cookieDomain: '.utua.work' })

      const deletions = writes.filter(
        (w) => w.startsWith(`${SESSION_COOKIE}=;`) && w.includes('max-age=0')
      )
      expect(deletions).toHaveLength(1)
      expect(deletions[0]).not.toContain('domain=')
    })

    it('stays host-only when no domain is configured', () => {
      getOrCreateSessionId()
      expect(window.localStorage.getItem(SESSION_LS_KEY)).toBeTruthy()
      expect(document.cookie).toContain(SESSION_COOKIE)
    })

    it('drops host-only cookies with the Secure attribute on an https page', () => {
      const writes: string[] = []
      const originalLocation = { ...window.location }
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, protocol: 'https:' },
        writable: true,
      })
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          writes.push(value)
        },
      })

      try {
        getOrCreateSessionId({ cookieDomain: '.utua.work' })

        // The write and its deletion must carry the same security attributes,
        // otherwise the browser keeps the secure cookie while the deletion
        // silently no-ops.
        const sessionWrite = writes.find(
          (w) => w.startsWith(`${SESSION_COOKIE}=`) && !w.includes('max-age=0')
        )
        expect(sessionWrite).toContain('; Secure')

        const deletions = writes.filter(
          (w) => w.startsWith(`${SESSION_COOKIE}=;`) && w.includes('max-age=0')
        )
        expect(deletions).toHaveLength(1)
        expect(deletions[0]).toContain('; Secure')
        expect(deletions[0]).not.toContain('domain=')
      } finally {
        Object.defineProperty(window, 'location', {
          configurable: true,
          value: originalLocation,
          writable: true,
        })
      }
    })
  })

  it('accepts a custom generator passed as a bare function (legacy signature)', () => {
    expect(getOrCreateSessionId(() => 'from-host')).toBe('from-host')
  })
})

describe('session-manager delegation to window.UtuaSession', () => {
  const windowWithUtua = window as unknown as {
    UtuaSession?: Record<string, unknown>
  }
  const originalUtuaSession = windowWithUtua.UtuaSession

  beforeEach(() => {
    resetSessionMemory()
  })

  afterEach(() => {
    delete windowWithUtua.UtuaSession
    document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; SameSite=Lax`
    document.cookie = `${ACTIVITY_COOKIE}=; path=/; max-age=0; SameSite=Lax`
    window.localStorage.clear()
  })

  afterAll(() => {
    if (originalUtuaSession) {
      windowWithUtua.UtuaSession = originalUtuaSession
    } else {
      delete windowWithUtua.UtuaSession
    }
  })

  it('keeps the local behavior when no window.UtuaSession global exists', () => {
    expect(windowWithUtua.UtuaSession).toBeUndefined()

    const first = getOrCreateSessionId()
    expect(isValidUuidV4(first)).toBe(true)

    const second = getOrCreateSessionId()
    expect(second).toBe(first)

    expect(getCurrentSessionId()).toBe(first)

    // custom provider is still honored by the local implementation
    const custom = jest.fn(() => EXTERNAL_ID)
    expect(getOrCreateSessionId(custom)).toBe(EXTERNAL_ID)
    expect(custom).toHaveBeenCalledTimes(1)
  })

  it('delegates getOrCreateSessionId to a well-formed external global', () => {
    const externalGetOrCreate = jest.fn(() => EXTERNAL_ID)
    const externalGetCurrent = jest.fn(() => EXTERNAL_ID)
    windowWithUtua.UtuaSession = {
      getOrCreateSessionId: externalGetOrCreate,
      getCurrentSessionId: externalGetCurrent,
    }

    expect(getOrCreateSessionId()).toBe(EXTERNAL_ID)
    expect(externalGetOrCreate).toHaveBeenCalledTimes(1)
    // delegation bypasses local storage writes entirely
    expect(document.cookie).not.toContain(SESSION_COOKIE)

    // caller options are forwarded to the external instance
    const custom = jest.fn(() => EXTERNAL_ID)
    expect(getOrCreateSessionId(custom)).toBe(EXTERNAL_ID)
    expect(externalGetOrCreate).toHaveBeenCalledWith(custom)
    expect(custom).not.toHaveBeenCalled()
  })

  it('does not recurse when the global is the manager’s own functions', () => {
    // The standalone bundle publishes the very functions running in this
    // module; delegating to it would call itself forever.
    windowWithUtua.UtuaSession = {
      getOrCreateSessionId,
      getCurrentSessionId,
    }

    const first = getOrCreateSessionId()
    expect(isValidUuidV4(first)).toBe(true)

    const second = getOrCreateSessionId()
    expect(second).toBe(first)

    expect(getCurrentSessionId()).toBe(first)
  })

  it('delegates getCurrentSessionId to the external global', () => {
    const externalGetCurrent = jest.fn(() => EXTERNAL_ID)
    windowWithUtua.UtuaSession = {
      getOrCreateSessionId: () => EXTERNAL_ID,
      getCurrentSessionId: externalGetCurrent,
    }

    expect(getCurrentSessionId()).toBe(EXTERNAL_ID)
    expect(externalGetCurrent).toHaveBeenCalledTimes(1)
  })

  it('ignores a malformed global (missing functions)', () => {
    windowWithUtua.UtuaSession = { getOrCreateSessionId: 'not-a-function' }

    const id = getOrCreateSessionId()
    expect(isValidUuidV4(id)).toBe(true)
    expect(getCurrentSessionId()).toBe(id)
  })

  it('does not break SSR/node when window is undefined', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalWindow = (globalThis as Record<string, unknown>).window

    // @ts-expect-error simulated SSR: no window global
    delete globalThis.window

    try {
      expect(isValidUuidV4(getOrCreateSessionId())).toBe(true)
      expect(getCurrentSessionId()).toBeUndefined()
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'window', descriptor)
      } else {
        ;(globalThis as Record<string, unknown>).window = originalWindow
      }
    }
  })
})
