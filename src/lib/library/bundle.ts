/**
 * Library bundles: one `.zip` that moves characters between RP Suite installs with everything
 * attached. Each character is stored as the app's own `.rppack.json` (so sprites, CGs, outfits,
 * relationship authoring etc. come along exactly as a single-character pack would), plus its chats
 * with full transcripts, its library media folder, the World Info books bound to it, and library
 * metadata a plain card loses (creation date, playlist membership).
 *
 * Layout:
 *   bundle.json                          { kind, version, exportedAt, characters: [{ folder, name }] }
 *   <folder>/character.rppack.json
 *   <folder>/library.json                { createdAt, playlists: string[] }
 *   <folder>/chats/<n>.json              { chat, messages }
 *   <folder>/media/<file>                raw bytes
 *   <folder>/lorebooks/<n>.json          { name, book }
 */

import { charactersApi, chatsApi, messagesApi, worldInfoBooksApi } from '@/lib/api/client'
import { buildCharacterPack, importCharacterPack, type CharacterPackV1 } from '@/lib/characters/pack'
import { fileToDataUrl } from '@/lib/characters/importExport'
import { wrapCardV2, type Character } from '@/lib/characters/cardSpec'
import { writeCharacterToPng } from '@/lib/characters/png'
import type { Chat, StoredMessage, WorldInfoBook } from '@/lib/types'
import { libraryApi } from './api'
import { createZip, readZip, type ZipEntry, type ZipInput } from './zip'
import type { Playlist } from './types'

const BUNDLE_KIND = 'rp-library-bundle'
const BUNDLE_VERSION = 1

export interface BundleOptions {
  chats: boolean
  media: boolean
  lorebooks: boolean
}

export type BundleLog = (line: string, level?: 'info' | 'warn' | 'error') => void

const textDecoder = new TextDecoder()

function folderName(character: Character, index: number): string {
  const safe = (character.card.name || 'character').replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 40) || 'character'
  return `${String(index + 1).padStart(3, '0')} ${safe}`
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export function bundleFilename(count: number): string {
  return `rp-library-${count}-character${count === 1 ? '' : 's'}-${new Date().toISOString().slice(0, 10)}.zip`
}

/** Builds the bundle zip for `characters`. Per-item failures are logged and skipped, never fatal. */
export async function exportBundle(characters: Character[], opts: BundleOptions, log: BundleLog): Promise<Uint8Array> {
  const files: ZipInput[] = []
  const [allChats, books, playlists] = await Promise.all([
    opts.chats ? chatsApi.list() : Promise.resolve([] as Chat[]),
    opts.lorebooks ? worldInfoBooksApi.list() : Promise.resolve([] as WorldInfoBook[]),
    libraryApi.playlists(),
  ])
  const manifest: { folder: string; name: string }[] = []

  for (const [i, character] of characters.entries()) {
    const folder = folderName(character, i)
    const name = character.card.name
    try {
      const pack = await buildCharacterPack(character)
      files.push({ path: `${folder}/character.rppack.json`, data: JSON.stringify(pack) })
      files.push({
        path: `${folder}/library.json`,
        data: JSON.stringify({
          id: character.id,
          createdAt: character.createdAt,
          playlists: playlists.filter((p) => p.characterIds.includes(character.id)).map((p) => ({ name: p.name, icon: p.icon, color: p.color })),
        }),
      })
      manifest.push({ folder, name })
      log(`${name}: card`)
    } catch (e) {
      log(`${name}: card export failed — ${e instanceof Error ? e.message : String(e)}`, 'error')
      continue
    }

    if (opts.chats) {
      const chats = allChats.filter((c) => c.characterId === character.id)
      for (const [n, chat] of chats.entries()) {
        try {
          const messages = await messagesApi.listByChat(chat.id)
          files.push({ path: `${folder}/chats/${n + 1}.json`, data: JSON.stringify({ chat, messages }) })
        } catch (e) {
          log(`${name}: chat "${chat.title}" skipped — ${e instanceof Error ? e.message : String(e)}`, 'warn')
        }
      }
      if (chats.length) log(`${name}: ${chats.length} chat${chats.length === 1 ? '' : 's'}`)
    }

    if (opts.media) {
      const media = await libraryApi.media(character.id)
      let ok = 0
      for (const item of media) {
        try {
          files.push({ path: `${folder}/media/${item.name}`, data: await fetchBytes(item.url) })
          ok++
        } catch (e) {
          log(`${name}: media "${item.name}" skipped — ${e instanceof Error ? e.message : String(e)}`, 'warn')
        }
      }
      if (ok) log(`${name}: ${ok} media file${ok === 1 ? '' : 's'}`)
    }

    if (opts.lorebooks) {
      const bound = books.filter((b) => b.boundCharacterIds?.includes(character.id))
      bound.forEach((b, n) => files.push({ path: `${folder}/lorebooks/${n + 1}.json`, data: JSON.stringify({ name: b.name, book: b.book }) }))
      if (bound.length) log(`${name}: ${bound.length} linked lorebook${bound.length === 1 ? '' : 's'}`)
    }
  }

  files.unshift({ path: 'bundle.json', data: JSON.stringify({ kind: BUNDLE_KIND, version: BUNDLE_VERSION, exportedAt: Date.now(), characters: manifest }) })
  return createZip(files)
}

function json<T>(entry: ZipEntry | undefined): T | undefined {
  return entry ? (JSON.parse(textDecoder.decode(entry.data)) as T) : undefined
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  opus: 'audio/opus',
}

/** Chat fields the server assigns itself on create, or that point at records outside this bundle. */
const CHAT_DROP_KEYS = ['id', 'characterId', 'createdAt', 'updatedAt', 'parentChatId', 'forkedFromMessageId', 'deletedAt'] as const

export interface BundleImportResult {
  characters: Character[]
}

/** Restores every character in a bundle as new records. Per-item failures are logged, not fatal. */
export async function importBundle(bytes: Uint8Array, log: BundleLog): Promise<BundleImportResult> {
  const entries = await readZip(bytes)
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const manifest = json<{ kind?: string; characters?: { folder: string; name: string }[] }>(byPath.get('bundle.json'))
  if (manifest?.kind !== BUNDLE_KIND || !Array.isArray(manifest.characters)) {
    throw new Error('Not an RP Suite library bundle (missing bundle.json).')
  }

  const created: Character[] = []
  const idMap = new Map<string, string>()
  const pendingChats: { folder: string; name: string; newId: string }[] = []
  let playlists: Playlist[] = await libraryApi.playlists()

  for (const { folder, name } of manifest.characters) {
    const pack = json<CharacterPackV1>(byPath.get(`${folder}/character.rppack.json`))
    if (!pack) {
      log(`${name}: no character.rppack.json, skipped`, 'error')
      continue
    }
    let character: Character
    try {
      ;({ character } = await importCharacterPack(pack))
      created.push(character)
      log(`${name}: imported`)
    } catch (e) {
      log(`${name}: import failed — ${e instanceof Error ? e.message : String(e)}`, 'error')
      continue
    }

    const meta = json<{ id?: string; createdAt?: number; playlists?: { name: string; icon?: string; color?: string }[] }>(
      byPath.get(`${folder}/library.json`),
    )
    if (meta?.id) idMap.set(meta.id, character.id)
    if (meta?.createdAt) await libraryApi.batch([character.id], { action: 'setCreatedAt', value: meta.createdAt })
    for (const pl of meta?.playlists ?? []) {
      let target = playlists.find((p) => p.name.toLowerCase() === pl.name.toLowerCase())
      if (!target) {
        target = await libraryApi.createPlaylist({ name: pl.name, icon: pl.icon, color: pl.color })
        playlists = [...playlists, target]
      }
      await libraryApi.playlistMembers(target.id, { add: [character.id] })
    }

    const mediaFiles = entries.filter((e) => e.path.startsWith(`${folder}/media/`))
    let mediaOk = 0
    for (const file of mediaFiles) {
      const fileName = file.path.slice(`${folder}/media/`.length)
      const mime = MIME_BY_EXT[fileName.split('.').pop()?.toLowerCase() ?? '']
      if (!mime) continue
      try {
        await libraryApi.uploadMedia(character.id, fileName, await fileToDataUrl(new Blob([file.data as BlobPart], { type: mime })))
        mediaOk++
      } catch (e) {
        log(`${name}: media "${fileName}" failed — ${e instanceof Error ? e.message : String(e)}`, 'warn')
      }
    }
    if (mediaOk) log(`${name}: ${mediaOk} media file${mediaOk === 1 ? '' : 's'}`)

    const books = entries.filter((e) => e.path.startsWith(`${folder}/lorebooks/`))
    for (const file of books) {
      const book = json<{ name: string; book: WorldInfoBook['book'] }>(file)
      if (!book?.book) continue
      await worldInfoBooksApi.create({ name: book.name, book: book.book, boundChatIds: [], boundCharacterIds: [character.id], boundWorldIds: [] })
    }
    if (books.length) log(`${name}: ${books.length} lorebook${books.length === 1 ? '' : 's'}`)

    pendingChats.push({ folder, name, newId: character.id })
  }

  // Chats last, so group-chat participants that are also in this bundle can be remapped.
  for (const { folder, name, newId } of pendingChats) {
    const chatFiles = entries.filter((e) => e.path.startsWith(`${folder}/chats/`))
    let ok = 0
    for (const file of chatFiles) {
      const data = json<{ chat: Chat; messages: StoredMessage[] }>(file)
      if (!data?.chat) continue
      try {
        const rest: Record<string, unknown> = { ...data.chat }
        for (const key of CHAT_DROP_KEYS) delete rest[key]
        const participants = (data.chat.participants ?? []).map((id) => idMap.get(id)).filter((id): id is string => !!id)
        const remappedRelationships = Object.fromEntries(
          Object.entries(data.chat.participantRelationships ?? {})
            .map(([id, track]) => [idMap.get(id), track] as const)
            .filter(([id]) => !!id),
        )
        const chat = await chatsApi.create({ characterId: newId, personaId: data.chat.personaId, title: data.chat.title })
        await chatsApi.update(chat.id, {
          ...rest,
          participants: participants.length ? participants : undefined,
          participantRelationships: Object.keys(remappedRelationships).length ? remappedRelationships : undefined,
          skipTouch: true,
        })
        for (const message of data.messages ?? []) {
          const { id: _id, chatId: _chatId, ...msg } = message
          await messagesApi.create({
            ...msg,
            chatId: chat.id,
            speakerId: msg.speakerId ? idMap.get(msg.speakerId) : undefined,
          })
        }
        ok++
      } catch (e) {
        log(`${name}: a chat failed to import — ${e instanceof Error ? e.message : String(e)}`, 'warn')
      }
    }
    if (ok) log(`${name}: ${ok} chat${ok === 1 ? '' : 's'} restored`)
  }

  return { characters: created }
}

/** Re-encodes any browser-decodable image as PNG (card PNGs need a PNG to carry the tEXt chunk). */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'))
}

/** "Character cards" export mode: every selected card as a SillyTavern-compatible PNG, zipped. */
export async function exportCardPngs(characters: Character[], log: BundleLog): Promise<Uint8Array> {
  const files: ZipInput[] = []
  const used = new Set<string>()
  for (const character of characters) {
    const base = (character.card.name || 'character').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'character'
    let fileName = `${base}.png`
    for (let n = 2; used.has(fileName.toLowerCase()); n++) fileName = `${base} (${n}).png`
    used.add(fileName.toLowerCase())
    try {
      const avatar = character.avatarDataUrl ? await (await fetch(character.avatarDataUrl)).blob() : undefined
      if (!avatar) {
        files.push({ path: `${base}.json`, data: JSON.stringify(wrapCardV2(character.card), null, 2) })
        log(`${character.card.name}: no portrait, exported as JSON`, 'warn')
        continue
      }
      const png = await writeCharacterToPng(await toPngBlob(avatar), wrapCardV2(character.card))
      files.push({ path: fileName, data: new Uint8Array(await png.arrayBuffer()) })
      log(`${character.card.name}: card PNG`)
    } catch (e) {
      log(`${character.card.name}: failed — ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }
  return createZip(files)
}

export function downloadBytes(bytes: Uint8Array, fileName: string, type = 'application/zip'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function deleteCharacters(ids: string[], log: BundleLog): Promise<number> {
  let n = 0
  for (const id of ids) {
    try {
      await charactersApi.remove(id)
      n++
    } catch (e) {
      log(`Delete failed — ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }
  return n
}
