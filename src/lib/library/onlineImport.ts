/**
 * Turning an online provider's character into a local one, and recognizing which online results
 * are already in the library (by provider link, not by name — names collide across creators).
 */

import { charactersApi } from '@/lib/api/client'
import { normalizeCardJson, type Character, type CharacterCardData } from '@/lib/characters/cardSpec'
import { fileToDataUrl } from '@/lib/characters/importExport'
import { errorMessage } from '@/lib/store/useToastStore'
import { libraryApi } from './api'
import { getProviderLink, withProviderLink } from './links'
import type { OnlineCharacterDetail, OnlineCharacterSummary, ProviderId, ProviderLink } from './types'

/** What the character create route accepts as an avatar (see `server/avatars.ts`). */
const AVATAR_TYPES: Record<string, true> = { 'image/png': true, 'image/jpeg': true, 'image/webp': true, 'image/gif': true }
const MAX_AVATAR_BYTES = 8 * 1024 * 1024

/** Lookup key for a provider link; Chub/CT paths are case-insensitive on the provider side. */
export function linkKey(provider: ProviderId, id: string): string {
  return `${provider}:${id.toLowerCase()}`
}

/** Linked local characters keyed by `linkKey`, for badging a whole result grid at once. */
export function localLinkIndex(characters: Character[]): Map<string, Character> {
  const index = new Map<string, Character>()
  for (const character of characters) {
    const link = getProviderLink(character.card)
    if (link) index.set(linkKey(link.provider, link.id), character)
  }
  return index
}

/** The local character linked to this online result, if it's already in the library. */
export function findLocalMatch(characters: Character[], summary: Pick<OnlineCharacterSummary, 'provider' | 'id'>): Character | undefined {
  const key = linkKey(summary.provider, summary.id)
  return characters.find((c) => {
    const link = getProviderLink(c.card)
    return !!link && linkKey(link.provider, link.id) === key
  })
}

export function providerLinkOf(detail: Pick<OnlineCharacterSummary, 'provider' | 'id' | 'url'>): ProviderLink {
  return { provider: detail.provider, id: detail.id, url: detail.url }
}

/**
 * The remote card as it would land locally: fully normalized, with the local card's `extensions`
 * kept so the provider link, favorite flag and other local-only settings never show up as changes.
 */
export function remoteCardForLocal(local: CharacterCardData, remote: CharacterCardData): CharacterCardData {
  return { ...normalizeCardJson(remote), extensions: local.extensions ?? {} }
}

/** Fetches the portrait through the same-origin proxy as a data URL, or undefined if none is usable. */
async function portraitDataUrl(detail: OnlineCharacterDetail): Promise<string | undefined> {
  for (const url of new Set([detail.imageUrl, detail.avatarUrl])) {
    if (!url) continue
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const blob = await res.blob()
      if (!AVATAR_TYPES[blob.type] || blob.size > MAX_AVATAR_BYTES) continue
      return await fileToDataUrl(blob)
    } catch {
      // Fall through to the next candidate (the smaller listing avatar).
    }
  }
  return undefined
}

/** Creates a local character from a provider character, linked back to its source. */
export async function importOnlineCharacter(detail: OnlineCharacterDetail, opts: { downloadGallery?: boolean } = {}): Promise<Character> {
  const card = withProviderLink(normalizeCardJson(detail.card), providerLinkOf(detail))
  const avatarDataUrl = await portraitDataUrl(detail)
  const created = await charactersApi.create({ card, avatarDataUrl })
  if (opts.downloadGallery && detail.gallery?.length) {
    try {
      await libraryApi.fetchMedia(created.id, detail.gallery)
    } catch (e) {
      throw new Error(`Imported "${card.name}", but its gallery download failed: ${errorMessage(e)}`)
    }
  }
  return created
}
