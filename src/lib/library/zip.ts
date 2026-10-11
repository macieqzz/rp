/**
 * A minimal ZIP writer/reader for library bundles — no dependency, works in the browser and in
 * Node (tests). Writes uncompressed ("stored") entries, since bundles are mostly PNG/JPEG/MP4 that
 * don't deflate anyway. Reads stored and deflated entries (deflate via `DecompressionStream`), so a
 * bundle re-zipped by an OS archiver still imports. No ZIP64, no encryption — 4GB is plenty here.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipInput {
  path: string
  data: Uint8Array | string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** DOS date/time for the local header — readers only use it for display. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** Builds a ZIP archive (stored entries, UTF-8 names). */
export function createZip(files: ZipInput[], now = new Date()): Uint8Array {
  const { time, date } = dosDateTime(now)
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.path.replace(/\\/g, '/').replace(/^\/+/, ''))
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data
    const crc = crc32(data)

    const local = new Uint8Array(30 + name.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // UTF-8 names
    lv.setUint16(8, 0, true) // stored
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + end.length)
  let pos = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, pos)
    pos += part.length
  }
  return out
}

export interface ZipEntry {
  path: string
  data: Uint8Array
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Reads every file entry (directories skipped) using the central directory. */
export async function readZip(input: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  let eocd = -1
  for (let i = input.length - 22; i >= Math.max(0, input.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record).')
  const count = view.getUint16(eocd + 10, true)
  let pos = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.')
    const method = view.getUint16(pos + 10, true)
    const compressedSize = view.getUint32(pos + 20, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localOffset = view.getUint32(pos + 42, true)
    const path = decoder.decode(input.subarray(pos + 46, pos + 46 + nameLen))
    pos += 46 + nameLen + extraLen + commentLen
    if (path.endsWith('/')) continue
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const raw = input.subarray(start, start + compressedSize)
    if (method === 0) entries.push({ path, data: raw })
    else if (method === 8) entries.push({ path, data: await inflateRaw(raw) })
    else throw new Error(`Unsupported ZIP compression method ${method} for "${path}".`)
  }
  return entries
}
