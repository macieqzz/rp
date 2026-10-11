/**
 * Character Library REST routes, mounted at `/api/library` (see `app.ts`): batch card edits, the
 * tags manager, playlists, local version snapshots, per-character media (upload, URL download,
 * album extraction, display-time localization) and chat statistics. Online provider browsing lives
 * in `providers.ts` (`/api/library/online`), album extractors in `extractors.ts`.
 */

import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { avatarsDir, characterStore, chatStore, db, messageStore, newId, playlistStore, snapshotStore } from '../db.ts'
import { resolveAvatar } from '../avatars.ts'
import { deleteMedia, downloadToMedia, listMedia, localizationMap, mediaCounts, saveMediaBuffer } from './media.ts'
import { extractAlbum } from './extractors.ts'
import { onlineRouter } from './providers.ts'
import type { CharacterCardData } from '../../src/lib/characters/cardSpec.ts'
import type { ExtractResult, MediaFetchResult } from '../../src/lib/library/types.ts'

type Row = Record<string, unknown>

/** Automatic snapshots kept per character; manual ones are never pruned. */
const MAX_AUTO_SNAPSHOTS = 10

function cardOf(row: Row): CharacterCardData {
  return (row.card ?? {}) as CharacterCardData
}

function normalizeTag(tag: unknown): string {
  return typeof tag === 'string' ? tag.trim().replace(/\s+/g, ' ').slice(0, 80) : ''
}

function tagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map(normalizeTag).filter(Boolean))]
}

function idList(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((v): v is string => typeof v === 'string' && !!v))] : []
}

/** Writes a card back without bumping anything but the card itself and `updatedAt`. */
function saveCard(id: string, card: CharacterCardData): Row | undefined {
  return characterStore.update(id, { card, updatedAt: Date.now() })
}

function avatarFilePath(avatarUrl: unknown): string | undefined {
  if (typeof avatarUrl !== 'string' || !avatarUrl.startsWith('/avatars/')) return undefined
  const rel = avatarUrl.slice('/avatars/'.length).split('?')[0]
  const abs = path.resolve(avatarsDir, decodeURIComponent(rel))
  return abs.startsWith(path.resolve(avatarsDir) + path.sep) && fs.existsSync(abs) ? abs : undefined
}

function snapshotDir(characterId: string): string {
  return path.join(avatarsDir, 'characters', characterId, 'snapshots')
}

/** Copies the live avatar beside the snapshot, since the live file is overwritten in place on change. */
function copyAvatarForSnapshot(characterId: string, snapshotId: string, avatarUrl: unknown): string | undefined {
  const src = avatarFilePath(avatarUrl)
  if (!src) return undefined
  const dir = snapshotDir(characterId)
  fs.mkdirSync(dir, { recursive: true })
  const ext = path.extname(src) || '.png'
  fs.copyFileSync(src, path.join(dir, `${snapshotId}${ext}`))
  return `/avatars/characters/${characterId}/snapshots/${snapshotId}${ext}`
}

function removeSnapshotFiles(row: Row): void {
  const file = avatarFilePath(row.avatarUrl)
  if (file) fs.rmSync(file, { force: true })
}

/**
 * Takes a snapshot of a character's current card. Automatic ones skip if the card is unchanged since
 * the newest snapshot, and are capped at `MAX_AUTO_SNAPSHOTS` per character (oldest dropped first).
 */
export function takeSnapshot(characterId: string, opts: { label?: string; auto?: boolean; reason?: string }): Row | undefined {
  const character = characterStore.get(characterId)
  if (!character) return undefined
  const existing = snapshotStore.list({ where: 'characterId = ?', params: [characterId], orderBy: 'createdAt DESC' })
  const cardJson = JSON.stringify(character.card)
  if (opts.auto && existing[0] && JSON.stringify(existing[0].card) === cardJson) return existing[0]
  const id = newId()
  const now = Date.now()
  const row = snapshotStore.insert({
    id,
    characterId,
    createdAt: now,
    label: opts.label?.trim() || (opts.auto ? opts.reason || 'Automatic backup' : `Snapshot ${new Date(now).toLocaleString()}`),
    auto: !!opts.auto,
    reason: opts.reason,
    card: character.card,
    avatarUrl: copyAvatarForSnapshot(characterId, id, character.avatarDataUrl),
  })
  if (opts.auto) {
    const autos = [row, ...existing].filter((s) => s.auto)
    for (const stale of autos.slice(MAX_AUTO_SNAPSHOTS)) {
      removeSnapshotFiles(stale)
      snapshotStore.remove(stale.id as string)
    }
  }
  return row
}

/** Drops everything the library keeps about a deleted character (snapshots, playlist membership). */
export function forgetCharacter(characterId: string): void {
  for (const snap of snapshotStore.list({ where: 'characterId = ?', params: [characterId] })) snapshotStore.remove(snap.id as string)
  for (const playlist of playlistStore.list()) {
    const ids = (playlist.characterIds as string[] | undefined) ?? []
    if (ids.includes(characterId)) {
      playlistStore.update(playlist.id as string, { characterIds: ids.filter((id) => id !== characterId), updatedAt: Date.now() })
    }
  }
}

function normalizePlaylist(body: Row, existing?: Row): Row {
  const out: Row = {}
  if ('name' in body || !existing) out.name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'New playlist'
  if ('icon' in body || !existing) out.icon = typeof body.icon === 'string' && /^[a-z0-9-]{1,40}$/i.test(body.icon) ? body.icon : 'list-music'
  if ('color' in body || !existing) out.color = typeof body.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(body.color) ? body.color : '#8b5cf6'
  if ('characterIds' in body || !existing) out.characterIds = idList(body.characterIds)
  return out
}

export function libraryRouter(): Router {
  const router = Router()

  router.use('/online', onlineRouter())

  // ---- Batch card edits ----

  router.post('/characters/batch', (req, res) => {
    const ids = idList(req.body?.ids)
    const action = req.body?.action as string
    const tags = tagList(req.body?.tags)
    let updated = 0
    db.exec('BEGIN')
    try {
      for (const id of ids) {
        const row = characterStore.get(id)
        if (!row) continue
        const card = { ...cardOf(row) }
        const current = tagList(card.tags)
        if (action === 'addTags') card.tags = [...new Set([...current, ...tags])]
        else if (action === 'removeTags') {
          const drop = new Set(tags.map((t) => t.toLowerCase()))
          card.tags = current.filter((t) => !drop.has(t.toLowerCase()))
        } else if (action === 'setTags') card.tags = tags
        else if (action === 'setFavorite') card.extensions = { ...(card.extensions ?? {}), fav: req.body?.value === true }
        else if (action === 'setDisplayName') {
          const ext = { ...(card.extensions ?? {}) }
          const name = typeof req.body?.value === 'string' ? req.body.value.trim() : ''
          if (name) ext.rp_display_name = name
          else delete ext.rp_display_name
          card.extensions = ext
        } else if (action === 'setLink') {
          const ext = { ...(card.extensions ?? {}) }
          const link = req.body?.value as Row | null
          if (link && typeof link.provider === 'string' && typeof link.id === 'string') {
            ext.rp_link = { provider: link.provider, id: link.id, url: typeof link.url === 'string' ? link.url : undefined, linkedAt: Date.now() }
            // SillyTavern's own Chub link field, so a card exported back to ST keeps its source.
            if (link.provider === 'chub') ext.chub = { ...((ext.chub as Row) ?? {}), full_path: link.id }
          } else {
            delete ext.rp_link
            delete ext.chub
          }
          card.extensions = ext
        } else if (action === 'setCreatedAt') {
          const at = Number(req.body?.value)
          if (!Number.isFinite(at) || at <= 0) throw new Error('"value" must be a timestamp.')
          characterStore.update(id, { createdAt: Math.round(at) })
          updated++
          continue
        } else {
          throw new Error(`Unknown batch action "${action}"`)
        }
        saveCard(id, card)
        updated++
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    res.json({ updated })
  })

  // ---- Tags manager ----

  router.get('/tags', (_req, res) => {
    const counts = new Map<string, number>()
    for (const row of characterStore.list()) for (const tag of tagList(cardOf(row).tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    res.json([...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)))
  })

  /** Renames (or, when `to` already exists, merges) a tag across every character, case-insensitively. */
  router.post('/tags/rename', (req, res) => {
    const from = normalizeTag(req.body?.from).toLowerCase()
    const to = normalizeTag(req.body?.to)
    if (!from || !to) return res.status(400).json({ error: '"from" and "to" are required.' })
    let updated = 0
    for (const row of characterStore.list()) {
      const tags = tagList(cardOf(row).tags)
      if (!tags.some((t) => t.toLowerCase() === from)) continue
      const next = [...new Set(tags.map((t) => (t.toLowerCase() === from ? to : t)))]
      saveCard(row.id as string, { ...cardOf(row), tags: next })
      updated++
    }
    res.json({ updated })
  })

  router.post('/tags/delete', (req, res) => {
    const drop = new Set(tagList(req.body?.tags).map((t) => t.toLowerCase()))
    if (drop.size === 0) return res.status(400).json({ error: '"tags" is required.' })
    let updated = 0
    for (const row of characterStore.list()) {
      const tags = tagList(cardOf(row).tags)
      const next = tags.filter((t) => !drop.has(t.toLowerCase()))
      if (next.length === tags.length) continue
      saveCard(row.id as string, { ...cardOf(row), tags: next })
      updated++
    }
    res.json({ updated })
  })

  // ---- Chat statistics ----

  router.get('/chat-stats', (_req, res) => {
    const counts = new Map<string, number>()
    for (const r of db.prepare('SELECT chatId, COUNT(*) AS n FROM messages GROUP BY chatId').all() as { chatId: string; n: number }[]) {
      counts.set(r.chatId, r.n)
    }
    const stats: Record<string, { chats: number; messages: number; lastChatAt: number }> = {}
    for (const chat of chatStore.list()) {
      if (chat.deletedAt) continue
      const ids = [chat.characterId as string, ...((chat.participants as string[] | undefined) ?? [])]
      for (const cid of new Set(ids)) {
        const s = (stats[cid] ??= { chats: 0, messages: 0, lastChatAt: 0 })
        s.chats++
        s.messages += counts.get(chat.id as string) ?? 0
        s.lastChatAt = Math.max(s.lastChatAt, Number(chat.updatedAt ?? 0))
      }
    }
    res.json(stats)
  })

  router.get('/characters/:id/chats', (req, res) => {
    const id = req.params.id
    const chats = chatStore
      .list({ orderBy: 'updatedAt DESC' })
      .filter((c) => !c.deletedAt && (c.characterId === id || ((c.participants as string[] | undefined) ?? []).includes(id)))
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chatId = ?')
    res.json(
      chats.map((chat) => {
        const messages = messageStore.list({ where: 'chatId = ?', params: [chat.id], orderBy: 'createdAt DESC' })
        const last = messages.find((m) => typeof m.text === 'string' && (m.text as string).trim())
        return {
          id: chat.id,
          title: chat.title,
          characterId: chat.characterId,
          personaId: chat.personaId,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          pinned: !!chat.pinned,
          group: ((chat.participants as string[] | undefined) ?? []).length > 0,
          messageCount: (countStmt.get(chat.id as string) as { n: number }).n,
          lastMessage: last ? { role: last.role, text: String(last.text).slice(0, 280), createdAt: last.createdAt } : undefined,
        }
      }),
    )
  })

  // ---- Media ----

  router.get('/media-counts', (_req, res) => {
    res.json(mediaCounts(characterStore.list().map((c) => c.id as string)))
  })

  router.get('/characters/:id/media', (req, res) => {
    res.json(listMedia(req.params.id))
  })

  router.get('/characters/:id/localization', (req, res) => {
    res.json(localizationMap(req.params.id))
  })

  router.post('/characters/:id/media', (req, res) => {
    if (!characterStore.get(req.params.id)) return res.status(404).json({ error: 'Not found' })
    const { fileName, dataUrl } = (req.body ?? {}) as { fileName?: unknown; dataUrl?: unknown }
    const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:([^;,]*)(;base64)?,(.*)$/s) : null
    if (!match || !match[2]) return res.status(400).json({ error: 'Expected a base64 data URL.' })
    const item = saveMediaBuffer(req.params.id, {
      suggestedName: typeof fileName === 'string' ? fileName : 'upload',
      buffer: Buffer.from(match[3], 'base64'),
      contentType: match[1],
    })
    res.status(201).json(item)
  })

  router.post('/characters/:id/media/fetch', async (req, res) => {
    if (!characterStore.get(req.params.id)) return res.status(404).json({ error: 'Not found' })
    const urls = idList(req.body?.urls).slice(0, 200)
    const results: MediaFetchResult[] = []
    // Sequential on purpose: polite to the hosts, and a big batch doesn't open 200 sockets at once.
    for (const url of urls) results.push(await downloadToMedia(req.params.id, url))
    res.json(results)
  })

  router.post('/characters/:id/media/extract', async (req, res) => {
    if (!characterStore.get(req.params.id)) return res.status(404).json({ error: 'Not found' })
    const urls = idList(req.body?.urls).slice(0, 50)
    const context = typeof req.body?.context === 'string' ? req.body.context : ''
    const results: ExtractResult[] = []
    for (const url of urls) results.push(await extractAlbum(url, { characterId: req.params.id, context }))
    res.json(results)
  })

  router.delete('/characters/:id/media/:name', (req, res) => {
    deleteMedia(req.params.id, req.params.name)
    res.status(204).end()
  })

  // ---- Playlists ----

  router.get('/playlists', (_req, res) => {
    res.json(playlistStore.list({ orderBy: 'createdAt' }))
  })

  router.post('/playlists', (req, res) => {
    const now = Date.now()
    res.status(201).json(playlistStore.insert({ id: newId(), ...normalizePlaylist(req.body ?? {}), createdAt: now, updatedAt: now }))
  })

  router.put('/playlists/:id', (req, res) => {
    const existing = playlistStore.get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    res.json(playlistStore.update(req.params.id, { ...normalizePlaylist(req.body ?? {}, existing), updatedAt: Date.now() }))
  })

  /** Adds/removes characters without the client having to resend (and race on) the whole list. */
  router.post('/playlists/:id/members', (req, res) => {
    const existing = playlistStore.get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const add = idList(req.body?.add)
    const remove = new Set(idList(req.body?.remove))
    const current = ((existing.characterIds as string[] | undefined) ?? []).filter((id) => !remove.has(id))
    const next = [...current, ...add.filter((id) => !current.includes(id))]
    res.json(playlistStore.update(req.params.id, { characterIds: next, updatedAt: Date.now() }))
  })

  router.delete('/playlists/:id', (req, res) => {
    playlistStore.remove(req.params.id)
    res.status(204).end()
  })

  // ---- Version snapshots ----

  router.get('/characters/:id/snapshots', (req, res) => {
    res.json(snapshotStore.list({ where: 'characterId = ?', params: [req.params.id], orderBy: 'createdAt DESC' }))
  })

  router.post('/characters/:id/snapshots', (req, res) => {
    const row = takeSnapshot(req.params.id, {
      label: typeof req.body?.label === 'string' ? req.body.label : undefined,
      auto: req.body?.auto === true,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
    })
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.status(201).json(row)
  })

  router.put('/snapshots/:id', (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 120) : ''
    if (!label) return res.status(400).json({ error: '"label" is required.' })
    const updated = snapshotStore.update(req.params.id, { label })
    if (!updated) return res.status(404).json({ error: 'Not found' })
    res.json(updated)
  })

  router.delete('/snapshots/:id', (req, res) => {
    const row = snapshotStore.get(req.params.id)
    if (row) {
      removeSnapshotFiles(row)
      snapshotStore.remove(req.params.id)
    }
    res.status(204).end()
  })

  /** Restores a snapshot's card (and, with `avatar: true`, its avatar), backing up the current state first. */
  router.post('/snapshots/:id/restore', (req, res) => {
    const snap = snapshotStore.get(req.params.id)
    if (!snap) return res.status(404).json({ error: 'Not found' })
    const characterId = snap.characterId as string
    if (!characterStore.get(characterId)) return res.status(404).json({ error: 'Character no longer exists.' })
    takeSnapshot(characterId, { auto: true, reason: `Before restoring "${snap.label as string}"` })
    const patch: Row = { card: snap.card, updatedAt: Date.now() }
    const avatarFile = req.body?.avatar === true ? avatarFilePath(snap.avatarUrl) : undefined
    if (avatarFile) {
      const ext = path.extname(avatarFile).slice(1).toLowerCase()
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      patch.avatarDataUrl = resolveAvatar('characters', characterId, `data:${mime};base64,${fs.readFileSync(avatarFile).toString('base64')}`)
    }
    res.json(characterStore.update(characterId, patch))
  })

  return router
}
