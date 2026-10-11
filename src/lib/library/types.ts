/**
 * Character Library data shapes shared by the client (`src/lib/library`, `src/components/library`)
 * and the server routes under `server/library/`. Type-only — the server imports this file with
 * `import type`, so nothing here may carry runtime code.
 */

import type { CharacterCardData } from '../characters/cardSpec'

/** Online catalogs the library can browse/import from without SillyTavern or a login-gated helper. */
export type ProviderId = 'chub' | 'wyvern' | 'chartavern' | 'botbooru'

/**
 * Where a local character came from online, stored on the card as `card.extensions.rp_link` so it
 * travels with exports. Chub links additionally mirror SillyTavern's own `extensions.chub.full_path`.
 */
export interface ProviderLink {
  provider: ProviderId
  /** The provider's own id/path for the character (Chub: `creator/slug` full path). */
  id: string
  /** Public page on the provider's site. */
  url?: string
  linkedAt?: number
}

/** A named, ordered virtual folder of characters. */
export interface Playlist {
  id: string
  name: string
  /** A key of `PLAYLIST_ICONS` (`src/components/library/playlistIcons.ts`). */
  icon: string
  /** CSS colour (hex). */
  color: string
  characterIds: string[]
  createdAt: number
  updatedAt: number
}

/** A point-in-time copy of a character's card. `auto` ones are capped/deduped per character. */
export interface CharacterSnapshot {
  id: string
  characterId: string
  createdAt: number
  label: string
  auto: boolean
  /** Why an automatic snapshot was taken ("Before restore", "Before card update", …). */
  reason?: string
  card: CharacterCardData
  /** Copy of the avatar at snapshot time (its own file, not the live one that gets overwritten). */
  avatarUrl?: string
}

export type MediaKind = 'image' | 'video' | 'audio'

/** One file in a character's library media folder (`data/avatars/characters/<id>/media/`). */
export interface MediaItem {
  name: string
  url: string
  kind: MediaKind
  size: number
  modifiedAt: number
  /** The remote URL this file was downloaded from, when known — drives display-time localization. */
  sourceUrl?: string
}

export interface MediaFetchResult {
  url: string
  ok: boolean
  item?: MediaItem
  /** Set when the file was already in the folder (same source URL), so nothing was downloaded. */
  skipped?: boolean
  error?: string
}

/** One album/gallery link resolved by a server-side extractor. */
export interface ExtractResult {
  url: string
  host: string
  ok: boolean
  /** Direct media URLs the extractor found. */
  found: number
  downloaded: MediaFetchResult[]
  error?: string
}

export type OnlineSort = 'popular' | 'newest' | 'updated' | 'rating' | 'downloads' | 'random'

export interface OnlineSearchParams {
  query?: string
  page?: number
  sort?: OnlineSort
  nsfw?: boolean
  /** Comma-free tag names to require. */
  tags?: string[]
  excludeTags?: string[]
  /** Restrict to one creator's characters. */
  creator?: string
}

export interface OnlineCharacterSummary {
  provider: ProviderId
  /** Provider-specific id usable with the detail/download routes. */
  id: string
  name: string
  creator: string
  avatarUrl?: string
  tagline?: string
  tags: string[]
  nsfw?: boolean
  url?: string
  tokens?: number
  downloads?: number
  likes?: number
  createdAt?: number
  updatedAt?: number
}

export interface OnlineSearchResult {
  items: OnlineCharacterSummary[]
  page: number
  hasMore: boolean
  total?: number
}

/** A full character fetched from a provider, normalized to our card shape. */
export interface OnlineCharacterDetail extends OnlineCharacterSummary {
  card: CharacterCardData
  /** Full-size portrait suitable for import (proxied URL). */
  imageUrl?: string
  /** Extra gallery images the provider exposes for this character. */
  gallery?: string[]
}

/** One entry in a provider's remote version history (Chub's git log). */
export interface RemoteVersion {
  id: string
  message: string
  createdAt: number
}
