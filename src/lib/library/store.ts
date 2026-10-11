/**
 * Character Library view state and preferences, persisted to localStorage as `rp-library` —
 * deliberately separate from the app-wide `rp-settings` store, since none of it affects chat.
 * Holds the live filter state (so the library reopens where you left it), saved filter presets and
 * the preset auto-applied on open, and the grid/hover/details display options.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { newId } from '@/lib/id'
import { DEFAULT_SEARCH_FIELDS, type SearchFields, type SortDir, type SortKey, type TagFilter, type TagMatchMode } from './search'

/** Everything a filter preset captures. */
export interface FilterState {
  search: string
  fields: SearchFields
  tagFilter: TagFilter
  includeMode: TagMatchMode
  excludeMode: TagMatchMode
  favoritesOnly: boolean
  playlistId: string | null
  sort: SortKey
  dir: SortDir
}

export interface FilterPreset {
  id: string
  name: string
  state: FilterState
}

export interface HoverOptions {
  tags: boolean
  creator: boolean
  tokens: boolean
  chats: boolean
  notes: boolean
}

export const DEFAULT_FILTER: FilterState = {
  search: '',
  fields: DEFAULT_SEARCH_FIELDS,
  tagFilter: {},
  includeMode: 'any',
  excludeMode: 'any',
  favoritesOnly: false,
  playlistId: null,
  sort: 'modified',
  dir: 'desc',
}

interface LibraryState {
  filter: FilterState
  presets: FilterPreset[]
  /** Applied every time the library opens, when set. */
  defaultPresetId: string | null
  hover: HoverOptions
  /** Prev/next chevrons in the details modal (README: on by default). */
  prevNextNav: boolean
  /** Minimum card width in px — the grid fits as many columns as that allows. */
  cardWidth: number
  /** Show the debug/metadata Info tab in character details. */
  showInfoTab: boolean
  /** Remote → local media URL swap in the details view, once embedded media is downloaded. */
  localizeMedia: boolean
  setFilter: (patch: Partial<FilterState>) => void
  resetFilter: () => void
  savePreset: (name: string) => void
  renamePreset: (id: string, name: string) => void
  deletePreset: (id: string) => void
  applyPreset: (id: string) => void
  setDefaultPreset: (id: string | null) => void
  setHover: (patch: Partial<HoverOptions>) => void
  setPrefs: (patch: Partial<Pick<LibraryState, 'prevNextNav' | 'cardWidth' | 'showInfoTab' | 'localizeMedia'>>) => void
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      filter: DEFAULT_FILTER,
      presets: [],
      defaultPresetId: null,
      hover: { tags: true, creator: true, tokens: true, chats: true, notes: false },
      prevNextNav: true,
      cardWidth: 170,
      showInfoTab: false,
      localizeMedia: true,
      setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
      resetFilter: () => set({ filter: DEFAULT_FILTER }),
      savePreset: (name) => {
        const trimmed = name.trim()
        if (!trimmed) return
        const existing = get().presets.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
        if (existing) {
          set((s) => ({ presets: s.presets.map((p) => (p.id === existing.id ? { ...p, state: s.filter } : p)) }))
        } else {
          set((s) => ({ presets: [...s.presets, { id: newId(), name: trimmed, state: s.filter }] }))
        }
      },
      renamePreset: (id, name) => set((s) => ({ presets: s.presets.map((p) => (p.id === id && name.trim() ? { ...p, name: name.trim() } : p)) })),
      deletePreset: (id) =>
        set((s) => ({
          presets: s.presets.filter((p) => p.id !== id),
          defaultPresetId: s.defaultPresetId === id ? null : s.defaultPresetId,
        })),
      applyPreset: (id) => {
        const preset = get().presets.find((p) => p.id === id)
        if (preset) set({ filter: { ...DEFAULT_FILTER, ...preset.state } })
      },
      setDefaultPreset: (id) => set({ defaultPresetId: id }),
      setHover: (patch) => set((s) => ({ hover: { ...s.hover, ...patch } })),
      setPrefs: (patch) => set(patch),
    }),
    {
      name: 'rp-library',
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<LibraryState>
        return {
          ...current,
          ...p,
          filter: { ...DEFAULT_FILTER, ...p.filter, fields: { ...DEFAULT_SEARCH_FIELDS, ...p.filter?.fields } },
          hover: { ...current.hover, ...p.hover },
        }
      },
    },
  ),
)
