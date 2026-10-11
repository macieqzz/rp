/**
 * Client for the Character Library's server routes (`server/library/routes.ts`, mounted at
 * `/api/library`). Shares `request()`/`invalidate()` with `src/lib/api/client.ts`, so the same
 * `useApiQuery` live-refetch mechanism covers library resources too.
 */

import { invalidate, request } from '@/lib/api/client'
import type { Character } from '@/lib/characters/cardSpec'
import type {
  CharacterSnapshot,
  ExtractResult,
  MediaFetchResult,
  MediaItem,
  OnlineCharacterDetail,
  OnlineSearchParams,
  OnlineSearchResult,
  Playlist,
  ProviderId,
  ProviderLink,
  RemoteVersion,
} from './types'

/** Downloads can take a while (many files, slow hosts) — well past the default 15s request timeout. */
const LONG_TIMEOUT_MS = 10 * 60 * 1000
const ONLINE_TIMEOUT_MS = 45000

export interface ChatStats {
  chats: number
  messages: number
  lastChatAt: number
}

export interface LibraryChatSummary {
  id: string
  title: string
  characterId: string
  personaId: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  group: boolean
  messageCount: number
  lastMessage?: { role: string; text: string; createdAt: number }
}

export type BatchAction =
  | { action: 'addTags' | 'removeTags' | 'setTags'; tags: string[] }
  | { action: 'setFavorite'; value: boolean }
  | { action: 'setDisplayName'; value: string }
  | { action: 'setLink'; value: ProviderLink | null }
  /** Bundle import: carry the original creation date over instead of "now". */
  | { action: 'setCreatedAt'; value: number }

function invalidateCharacters() {
  invalidate('characters')
}

export const libraryApi = {
  async batch(ids: string[], op: BatchAction): Promise<{ updated: number }> {
    const result = await request<{ updated: number }>('POST', '/library/characters/batch', { ids, ...op })
    invalidateCharacters()
    return result
  },

  tags(): Promise<{ tag: string; count: number }[]> {
    return request('GET', '/library/tags')
  },
  async renameTag(from: string, to: string): Promise<{ updated: number }> {
    const result = await request<{ updated: number }>('POST', '/library/tags/rename', { from, to })
    invalidateCharacters()
    return result
  },
  async deleteTags(tags: string[]): Promise<{ updated: number }> {
    const result = await request<{ updated: number }>('POST', '/library/tags/delete', { tags })
    invalidateCharacters()
    return result
  },

  chatStats(): Promise<Record<string, ChatStats>> {
    return request('GET', '/library/chat-stats')
  },
  characterChats(characterId: string): Promise<LibraryChatSummary[]> {
    return request('GET', `/library/characters/${characterId}/chats`)
  },

  mediaCounts(): Promise<Record<string, number>> {
    return request('GET', '/library/media-counts')
  },
  media(characterId: string): Promise<MediaItem[]> {
    return request('GET', `/library/characters/${characterId}/media`)
  },
  localization(characterId: string): Promise<Record<string, string>> {
    return request('GET', `/library/characters/${characterId}/localization`)
  },
  async uploadMedia(characterId: string, fileName: string, dataUrl: string): Promise<MediaItem> {
    const result = await request<MediaItem>('POST', `/library/characters/${characterId}/media`, { fileName, dataUrl }, { timeoutMs: LONG_TIMEOUT_MS })
    invalidate('library-media')
    return result
  },
  async fetchMedia(characterId: string, urls: string[]): Promise<MediaFetchResult[]> {
    const result = await request<MediaFetchResult[]>('POST', `/library/characters/${characterId}/media/fetch`, { urls }, { timeoutMs: LONG_TIMEOUT_MS })
    invalidate('library-media')
    return result
  },
  async extractMedia(characterId: string, urls: string[], context?: string): Promise<ExtractResult[]> {
    const result = await request<ExtractResult[]>('POST', `/library/characters/${characterId}/media/extract`, { urls, context }, { timeoutMs: LONG_TIMEOUT_MS })
    invalidate('library-media')
    return result
  },
  async deleteMedia(characterId: string, name: string): Promise<void> {
    await request<void>('DELETE', `/library/characters/${characterId}/media/${encodeURIComponent(name)}`)
    invalidate('library-media')
  },

  playlists(): Promise<Playlist[]> {
    return request('GET', '/library/playlists')
  },
  async createPlaylist(input: Partial<Pick<Playlist, 'name' | 'icon' | 'color' | 'characterIds'>>): Promise<Playlist> {
    const result = await request<Playlist>('POST', '/library/playlists', input)
    invalidate('library-playlists')
    return result
  },
  async updatePlaylist(id: string, patch: Partial<Pick<Playlist, 'name' | 'icon' | 'color' | 'characterIds'>>): Promise<Playlist> {
    const result = await request<Playlist>('PUT', `/library/playlists/${id}`, patch)
    invalidate('library-playlists')
    return result
  },
  async playlistMembers(id: string, change: { add?: string[]; remove?: string[] }): Promise<Playlist> {
    const result = await request<Playlist>('POST', `/library/playlists/${id}/members`, change)
    invalidate('library-playlists')
    return result
  },
  async deletePlaylist(id: string): Promise<void> {
    await request<void>('DELETE', `/library/playlists/${id}`)
    invalidate('library-playlists')
  },

  snapshots(characterId: string): Promise<CharacterSnapshot[]> {
    return request('GET', `/library/characters/${characterId}/snapshots`)
  },
  async takeSnapshot(characterId: string, opts: { label?: string; auto?: boolean; reason?: string } = {}): Promise<CharacterSnapshot> {
    const result = await request<CharacterSnapshot>('POST', `/library/characters/${characterId}/snapshots`, opts)
    invalidate('library-snapshots')
    return result
  },
  async renameSnapshot(id: string, label: string): Promise<CharacterSnapshot> {
    const result = await request<CharacterSnapshot>('PUT', `/library/snapshots/${id}`, { label })
    invalidate('library-snapshots')
    return result
  },
  async deleteSnapshot(id: string): Promise<void> {
    await request<void>('DELETE', `/library/snapshots/${id}`)
    invalidate('library-snapshots')
  },
  async restoreSnapshot(id: string, opts: { avatar?: boolean } = {}): Promise<Character> {
    const result = await request<Character>('POST', `/library/snapshots/${id}/restore`, opts)
    invalidate('library-snapshots')
    invalidateCharacters()
    return result
  },
}

function searchQuery(params: OnlineSearchParams): string {
  const q = new URLSearchParams()
  if (params.query) q.set('q', params.query)
  if (params.page) q.set('page', String(params.page))
  if (params.sort) q.set('sort', params.sort)
  if (params.nsfw) q.set('nsfw', '1')
  if (params.tags?.length) q.set('tags', params.tags.join(','))
  if (params.excludeTags?.length) q.set('excludeTags', params.excludeTags.join(','))
  if (params.creator) q.set('creator', params.creator)
  return q.toString()
}

/** Online provider proxy (`server/library/providers.ts`). Ids are opaque, URL-encoded per call. */
export const onlineApi = {
  search(provider: ProviderId, params: OnlineSearchParams): Promise<OnlineSearchResult> {
    return request('GET', `/library/online/${provider}/search?${searchQuery(params)}`, undefined, { timeoutMs: ONLINE_TIMEOUT_MS })
  },
  character(provider: ProviderId, id: string): Promise<OnlineCharacterDetail> {
    return request('GET', `/library/online/${provider}/character?id=${encodeURIComponent(id)}`, undefined, { timeoutMs: ONLINE_TIMEOUT_MS })
  },
  /** Resolves a pasted provider URL (any supported site) to `{ provider, id }`, or 404s. */
  resolveUrl(url: string): Promise<{ provider: ProviderId; id: string }> {
    return request('GET', `/library/online/resolve?url=${encodeURIComponent(url)}`, undefined, { timeoutMs: ONLINE_TIMEOUT_MS })
  },
  versions(provider: ProviderId, id: string): Promise<RemoteVersion[]> {
    return request('GET', `/library/online/${provider}/versions?id=${encodeURIComponent(id)}`, undefined, { timeoutMs: ONLINE_TIMEOUT_MS })
  },
  /** One remote version's card (Chub only). */
  version(provider: ProviderId, id: string, versionId: string): Promise<OnlineCharacterDetail> {
    return request(
      'GET',
      `/library/online/${provider}/version?id=${encodeURIComponent(id)}&version=${encodeURIComponent(versionId)}`,
      undefined,
      { timeoutMs: ONLINE_TIMEOUT_MS },
    )
  },
  /** Same-origin proxy URL for a provider image (CORS + hotlink protection). */
  imageUrl(url: string): string {
    return `/api/library/online/image?url=${encodeURIComponent(url)}`
  },
}
