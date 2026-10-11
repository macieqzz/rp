/** For sub-resources nested inside a JSON blob (e.g. an objective's tasks) that never get their own POST endpoint — everything else gets its id assigned by the server on create. */
export function newId(): string {
  // `crypto.randomUUID` only exists in a secure context (HTTPS or localhost), so it's missing when
  // the app is opened over plain http from another machine on the LAN. `getRandomValues` has no
  // such restriction, so fall back to building the same RFC 4122 v4 UUID from it.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
