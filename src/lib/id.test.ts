import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from './id'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns a v4 UUID', () => {
    expect(newId()).toMatch(UUID_V4)
  })

  it('still works outside a secure context, where crypto.randomUUID is missing (plain http on the LAN)', () => {
    vi.stubGlobal('crypto', { getRandomValues: <T extends Uint8Array>(a: T) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a } })
    const a = newId()
    expect(a).toMatch(UUID_V4)
    expect(newId()).not.toBe(a)
  })
})
