import type { CharacterCardData } from '@/lib/characters/cardSpec'
import type { ProviderId, ProviderLink } from './types'

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  chub: 'Chub',
  wyvern: 'Wyvern',
  chartavern: 'CharacterTavern',
  botbooru: 'Botbooru',
}

const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as ProviderId[]

/**
 * A card's online source: our own `extensions.rp_link`, or SillyTavern's `extensions.chub.full_path`
 * for a card that was linked/imported in SillyTavern before it came here.
 */
export function getProviderLink(card: CharacterCardData): ProviderLink | undefined {
  const ext = card.extensions ?? {}
  const own = ext.rp_link
  if (own && typeof own === 'object') {
    const { provider, id, url, linkedAt } = own as Record<string, unknown>
    if (typeof provider === 'string' && PROVIDER_IDS.includes(provider as ProviderId) && typeof id === 'string' && id) {
      return {
        provider: provider as ProviderId,
        id,
        url: typeof url === 'string' ? url : undefined,
        linkedAt: typeof linkedAt === 'number' ? linkedAt : undefined,
      }
    }
  }
  const chub = ext.chub
  if (chub && typeof chub === 'object') {
    const fullPath = (chub as Record<string, unknown>).full_path
    if (typeof fullPath === 'string' && fullPath) return { provider: 'chub', id: fullPath, url: `https://chub.ai/characters/${fullPath}` }
  }
  return undefined
}

/** Card extensions with `link` recorded (or cleared, for `null`), mirroring Chub links into ST's field. */
export function withProviderLink(card: CharacterCardData, link: ProviderLink | null): CharacterCardData {
  const ext = { ...(card.extensions ?? {}) }
  if (link) {
    ext.rp_link = { ...link, linkedAt: link.linkedAt ?? Date.now() }
    if (link.provider === 'chub') ext.chub = { ...((ext.chub as Record<string, unknown> | undefined) ?? {}), full_path: link.id }
  } else {
    delete ext.rp_link
    delete ext.chub
  }
  return { ...card, extensions: ext }
}

/** SillyTavern's favorite flag (`data.extensions.fav`), which round-trips through card exports. */
export function isFavorite(card: CharacterCardData): boolean {
  const fav = card.extensions?.fav
  return fav === true || fav === 'true'
}

/** The library-only display name override, if one is set. */
export function displayNameOf(card: CharacterCardData): string {
  const override = card.extensions?.rp_display_name
  return typeof override === 'string' && override.trim() ? override.trim() : card.name
}
