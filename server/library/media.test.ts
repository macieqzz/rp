import { describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(async (host: string) =>
      host === 'rebind.example' ? [{ address: '192.168.10.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }],
    ),
  },
}))

const { assertPublicHost } = await import('./media.ts')

describe('assertPublicHost', () => {
  it('rejects a public-looking name that resolves to a LAN address', async () => {
    await expect(assertPublicHost(new URL('https://rebind.example/a.png'))).rejects.toThrow(/private/)
  })

  it('allows a name that resolves to a public address', async () => {
    await expect(assertPublicHost(new URL('https://example.com/a.png'))).resolves.toBeUndefined()
  })
})
