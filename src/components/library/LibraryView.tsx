import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  BookOpen,
  CheckSquare,
  Copy,
  Dices,
  Download,
  Eye,
  Heart,
  HelpCircle,
  Link2,
  ListPlus,
  MessagesSquare,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Tags,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { Character } from '@/lib/characters/cardSpec'
import { charactersApi, personasApi } from '@/lib/api/client'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import { libraryApi } from '@/lib/library/api'
import { getProviderLink, isFavorite } from '@/lib/library/links'
import { buildEntries, cycleTagState, runQuery, tagCounts, type SortKey } from '@/lib/library/search'
import { useLibraryStore } from '@/lib/library/store'
import { useSettingsStore } from '@/lib/store/useSettingsStore'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { LibraryGrid } from './LibraryGrid'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { CharacterDetailsModal, type DetailsTabId } from './CharacterDetailsModal'
import { BatchTagDialog, TagsManagerDialog } from './TagDialogs'
import { AddToPlaylistDialog, PlaylistDialog, PlaylistIcon } from './PlaylistDialogs'
import { ExportDialog, ImportDialog } from './TransferDialogs'
import { DuplicatesDialog } from './DuplicatesDialog'
import { LibrarySettingsDialog } from './LibrarySettingsDialog'
import { CardUpdatesDialog } from './CardUpdatesDialog'
import { RecommenderPanel } from './RecommenderPanel'
import { LinkProviderDialog } from './LinkProviderDialog'
import { OnlineBrowser } from './online/OnlineBrowser'
import type { Playlist } from '@/lib/library/types'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'modified', label: 'Last modified' },
  { value: 'created', label: 'Date created' },
  { value: 'tokens', label: 'Token count' },
  { value: 'chats', label: 'Chat count' },
  { value: 'lastChat', label: 'Last chatted' },
  { value: 'random', label: 'Random' },
  { value: 'playlist', label: 'Playlist order' },
]

const SEARCH_HELP = `Prefix filters (combine freely with text):
creator:name   fav:yes|no   linked:yes|no
chub: wyvern: ct: botbooru: (yes|no)
version:1.0|none   uid:id|none   tag:elf
gallery:any|none   playlist:name|any|none   chats:yes|no
Quote values with spaces: creator:"John Smith"`

type Dialog =
  | { kind: 'batchTags' | 'export' | 'addToPlaylist' | 'updates'; ids: string[] }
  | { kind: 'playlist'; playlist?: Playlist; members?: string[] }
  | { kind: 'link'; id: string }
  | { kind: 'import' | 'tags' | 'duplicates' | 'settings' | 'recommender' }

/**
 * The Character Library: a searchable, filterable, virtual-scrolling grid of every character, with
 * tri-state tag filters, playlists, saved filter presets, multi-select batch operations, a rich
 * details modal, bundle import/export and online browsing. The deep editor stays the Characters view.
 */
export function LibraryView({
  onOpenChat,
  onOpenChatForCharacter,
  onEditCharacter,
  onCreateCharacter,
  onOpenWorldInfo,
}: {
  onOpenChat: (chatId: string) => void
  onOpenChatForCharacter?: (characterId: string) => void
  onEditCharacter: (id: string) => void
  onCreateCharacter: () => void
  onOpenWorldInfo: () => void
}) {
  const characters = useApiQuery('characters', () => charactersApi.list(), [])
  const playlists = useApiQuery('library-playlists', () => libraryApi.playlists(), []) ?? []
  const mediaCounts = useApiQuery(['library-media', 'characters'], () => libraryApi.mediaCounts(), [])
  const chatStats = useApiQuery(['chats', 'messages', 'characters'], () => libraryApi.chatStats(), [])
  const personas = useApiQuery('personas', () => personasApi.list(), []) ?? []
  const activePersonaId = useSettingsStore((s) => s.activePersonaId)
  const userName = personas.find((p) => p.id === activePersonaId)?.name ?? personas[0]?.name ?? 'You'

  const store = useLibraryStore()
  const filter = store.filter
  const setFilter = store.setFilter
  const [view, setView] = useState<'library' | 'online'>('library')
  const [seed, setSeed] = useState(() => Date.now())
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openTab, setOpenTab] = useState<DetailsTabId>('details')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [showAllTags, setShowAllTags] = useState(false)
  const [tagQuery, setTagQuery] = useState('')
  const [presetName, setPresetName] = useState('')
  const [showPresets, setShowPresets] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [showFields, setShowFields] = useState(false)

  // The default preset lands you in your usual view every time the library opens.
  useEffect(() => {
    const { defaultPresetId, applyPreset } = useLibraryStore.getState()
    if (defaultPresetId) applyPreset(defaultPresetId)
  }, [])

  const list = characters ?? []
  const byId = useMemo(() => new Map(list.map((c) => [c.id, c])), [list])
  const entries = useMemo(() => buildEntries(list, { playlists, mediaCounts, chatStats }), [list, playlists, mediaCounts, chatStats])
  const activePlaylist = playlists.find((p) => p.id === filter.playlistId)
  const results = useMemo(
    () => runQuery(entries, { ...filter, playlist: activePlaylist, seed }),
    [entries, filter, activePlaylist, seed],
  )
  const allTags = useMemo(() => tagCounts(entries), [entries])
  const tagNames = useMemo(() => allTags.map((t) => t.tag), [allTags])

  const openIndex = openId ? results.findIndex((e) => e.id === openId) : -1
  const openCharacter = openId ? byId.get(openId) : undefined

  const open = useCallback((id: string, tab: DetailsTabId = 'details') => {
    setOpenTab(tab)
    setOpenId(id)
  }, [])

  const toggleSelect = useCallback(
    (id: string, range: boolean) => {
      setSelectMode(true)
      setSelected((prev) => {
        const next = new Set(prev)
        if (range && anchor) {
          const a = results.findIndex((e) => e.id === anchor)
          const b = results.findIndex((e) => e.id === id)
          if (a >= 0 && b >= 0) {
            for (const e of results.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(e.id)
            return next
          }
        }
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setAnchor(id)
    },
    [anchor, results],
  )

  const toggleFavorite = useCallback(
    (id: string) => {
      const c = byId.get(id)
      if (c) libraryApi.batch([id], { action: 'setFavorite', value: !isFavorite(c.card) }).catch((e) => toastError(errorMessage(e)))
    },
    [byId],
  )

  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  // Space toggles multi-select, Escape leaves it — only when nothing else (a modal, a text field) has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || t?.isContentEditable) return
      if (document.querySelector('[role="dialog"]') || view !== 'library') return
      if (e.key === ' ') {
        e.preventDefault()
        setSelectMode((v) => {
          if (v) setSelected(new Set())
          return !v
        })
      } else if (e.key === 'Escape') exitSelect()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  const deleteIds = async (ids: string[]) => {
    const names = ids.map((id) => byId.get(id)?.card.name).filter(Boolean)
    const ok = await confirmDialog({
      title: ids.length === 1 ? `Delete ${names[0]}?` : `Delete ${ids.length} characters?`,
      body: 'Their chats, media and snapshots are deleted too. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    let n = 0
    for (const id of ids) {
      try {
        await charactersApi.remove(id)
        n++
      } catch (e) {
        toastError(errorMessage(e))
      }
    }
    toastSuccess(`Deleted ${n} character${n === 1 ? '' : 's'}.`)
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))))
  }

  const setFavoriteMany = async (ids: string[], value: boolean) => {
    const { updated } = await libraryApi.batch(ids, { action: 'setFavorite', value })
    toastSuccess(`${value ? 'Favorited' : 'Unfavorited'} ${updated}.`)
  }

  const menuItems = (id: string): (ContextMenuItem | 'separator')[] => {
    const c = byId.get(id)
    if (!c) return []
    const fav = isFavorite(c.card)
    const linked = !!getProviderLink(c.card)
    return [
      { label: 'Edit character', icon: Pencil, onSelect: () => onEditCharacter(id) },
      { label: 'View details & versions', icon: Eye, onSelect: () => open(id) },
      { label: 'Chats', icon: MessagesSquare, onSelect: () => open(id, 'chats') },
      'separator',
      { label: fav ? 'Remove from favorites' : 'Add to favorites', icon: Heart, onSelect: () => toggleFavorite(id) },
      { label: 'Add to playlist…', icon: ListPlus, onSelect: () => setDialog({ kind: 'addToPlaylist', ids: [id] }) },
      ...(activePlaylist
        ? [{ label: `Remove from "${activePlaylist.name}"`, icon: X, onSelect: () => void libraryApi.playlistMembers(activePlaylist.id, { remove: [id] }) }]
        : []),
      { label: 'Edit tags…', icon: Tags, onSelect: () => setDialog({ kind: 'batchTags', ids: [id] }) },
      { label: linked ? 'Provider link…' : 'Link to online source…', icon: Link2, onSelect: () => setDialog({ kind: 'link', id }) },
      ...(linked ? [{ label: 'Check for updates', icon: RefreshCw, onSelect: () => setDialog({ kind: 'updates', ids: [id] }) }] : []),
      { label: 'Export…', icon: Download, onSelect: () => setDialog({ kind: 'export', ids: [id] }) },
      { label: selected.has(id) ? 'Deselect' : 'Select', icon: CheckSquare, onSelect: () => toggleSelect(id, false) },
      'separator',
      { label: 'Delete', icon: Trash2, danger: true, onSelect: () => void deleteIds([id]) },
    ]
  }

  const tagState = filter.tagFilter
  const activeTagCount = Object.keys(tagState).length
  const visibleTags = (showAllTags ? allTags.filter((t) => t.key.includes(tagQuery.toLowerCase())) : allTags.slice(0, 24)).concat(
    // Always show tags that are actively filtering, even outside the top list.
    showAllTags ? [] : allTags.slice(24).filter((t) => tagState[t.key]),
  )
  const selectedIds = [...selected]
  const selectedChars = selectedIds.map((id) => byId.get(id)).filter((c): c is Character => !!c)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <h2 className="font-display text-lg text-text">Character Library</h2>
        <SegmentedControl
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'library', label: `Library${characters ? ` (${list.length})` : ''}` },
            { value: 'online', label: 'Online' },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={() => setDialog({ kind: 'import' })} className="flex items-center gap-1.5">
            <Upload size={14} /> Import
          </Button>
          <Button variant="primary" onClick={onCreateCharacter} className="flex items-center gap-1.5">
            <Plus size={14} /> New
          </Button>
          <div className="relative">
            <Button variant="ghost" aria-label="More" onClick={() => setShowMore((v) => !v)}>
              <MoreVertical size={16} />
            </Button>
            {showMore && (
              <ContextMenu
                x={window.innerWidth - 16}
                y={56}
                onClose={() => setShowMore(false)}
                items={[
                  { label: 'Card recommender (AI)', icon: Sparkles, onSelect: () => setDialog({ kind: 'recommender' }) },
                  { label: 'Tags manager', icon: Tags, onSelect: () => setDialog({ kind: 'tags' }) },
                  { label: 'Find duplicates', icon: Copy, onSelect: () => setDialog({ kind: 'duplicates' }) },
                  {
                    label: 'Check all linked for updates',
                    icon: RefreshCw,
                    onSelect: () => setDialog({ kind: 'updates', ids: list.filter((c) => getProviderLink(c.card)).map((c) => c.id) }),
                  },
                  { label: 'Lorebooks (World Info)', icon: BookOpen, onSelect: onOpenWorldInfo },
                  'separator',
                  { label: 'Library settings', icon: Settings2, onSelect: () => setDialog({ kind: 'settings' }) },
                ]}
              />
            )}
          </div>
        </div>
      </div>

      {view === 'online' ? (
        <OnlineBrowser characters={list} onOpenLocal={(id) => open(id)} />
      ) : (
        <>
          <div className="shrink-0 space-y-2 px-4 pb-2 pt-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  value={filter.search}
                  onChange={(e) => setFilter({ search: e.target.value })}
                  placeholder="Search name, tags, creator… or creator:name fav:yes"
                  className="w-full rounded-xl bg-bg-sunken py-2 pl-8 pr-16 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
                />
                <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 text-text-muted">
                  {filter.search && (
                    <button type="button" aria-label="Clear search" onClick={() => setFilter({ search: '' })} className="p-0.5 hover:text-text">
                      <X size={13} />
                    </button>
                  )}
                  <span title={SEARCH_HELP} className="cursor-help p-0.5">
                    <HelpCircle size={13} />
                  </span>
                </div>
              </div>
              <div className="relative">
                <Button variant="ghost" onClick={() => setShowFields((v) => !v)} className="text-xs">
                  Fields
                </Button>
                {showFields && (
                  <div className="absolute left-0 top-full z-30 mt-1 w-40 rounded-xl border border-border bg-bg-elevated p-2 shadow-xl">
                    {(['name', 'tags', 'creator', 'notes'] as const).map((f) => (
                      <label key={f} className="flex items-center gap-2 py-0.5 text-sm text-text">
                        <input type="checkbox" checked={filter.fields[f]} onChange={(e) => setFilter({ fields: { ...filter.fields, [f]: e.target.checked } })} />
                        {f === 'notes' ? "Creator's notes" : f[0].toUpperCase() + f.slice(1)}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <select
                value={filter.sort}
                onChange={(e) => setFilter({ sort: e.target.value as SortKey })}
                aria-label="Sort by"
                className="rounded-xl bg-bg-sunken px-2 py-2 text-sm text-text outline-none"
              >
                {SORT_OPTIONS.filter((o) => o.value !== 'playlist' || activePlaylist).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {filter.sort === 'random' ? (
                <Button variant="ghost" title="Reshuffle" onClick={() => setSeed(Date.now())}>
                  <Dices size={15} />
                </Button>
              ) : (
                <Button variant="ghost" title={filter.dir === 'asc' ? 'Ascending' : 'Descending'} onClick={() => setFilter({ dir: filter.dir === 'asc' ? 'desc' : 'asc' })}>
                  {filter.dir === 'asc' ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />}
                </Button>
              )}
              <Button
                variant="ghost"
                title="Favorites only"
                onClick={() => setFilter({ favoritesOnly: !filter.favoritesOnly })}
                className={filter.favoritesOnly ? 'text-romance' : ''}
              >
                <Heart size={15} fill={filter.favoritesOnly ? 'currentColor' : 'none'} />
              </Button>
              <Button
                variant="ghost"
                title="Multi-select (Space)"
                onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                className={selectMode ? 'text-accent' : ''}
              >
                <CheckSquare size={15} />
              </Button>
              <div className="relative">
                <Button variant="ghost" onClick={() => setShowPresets((v) => !v)} className="text-xs">
                  Presets
                </Button>
                {showPresets && (
                  <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-xl border border-border bg-bg-elevated p-2 shadow-xl">
                    <div className="mb-2 flex gap-1">
                      <input
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && presetName.trim()) {
                            store.savePreset(presetName)
                            setPresetName('')
                          }
                        }}
                        placeholder="Save current filters as…"
                        className="min-w-0 flex-1 rounded-lg bg-bg-sunken px-2 py-1 text-sm text-text outline-none"
                      />
                      <Button
                        disabled={!presetName.trim()}
                        onClick={() => {
                          store.savePreset(presetName)
                          setPresetName('')
                        }}
                      >
                        Save
                      </Button>
                    </div>
                    {store.presets.length === 0 && <p className="px-1 text-xs text-text-muted">No presets yet. Saving with an existing name overwrites it.</p>}
                    {store.presets.map((p) => (
                      <div key={p.id} className="group flex items-center gap-1 rounded-lg px-1 hover:bg-bg-sunken">
                        <button
                          type="button"
                          onClick={() => {
                            store.applyPreset(p.id)
                            setShowPresets(false)
                          }}
                          className="flex-1 truncate py-1 text-left text-sm text-text"
                        >
                          {p.name}
                          {store.defaultPresetId === p.id && <span className="ml-1 text-[10px] text-accent">default</span>}
                        </button>
                        <button
                          type="button"
                          title="Rename"
                          onClick={() => {
                            const name = window.prompt('Rename preset', p.name)
                            if (name) store.renamePreset(p.id, name)
                          }}
                          className="p-1 text-text-muted opacity-0 hover:text-text group-hover:opacity-100"
                        >
                          <Pencil size={12} />
                        </button>
                        <button type="button" title="Delete" onClick={() => store.deletePreset(p.id)} className="p-1 text-text-muted opacity-0 hover:text-danger group-hover:opacity-100">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={store.resetFilter} className="mt-1 w-full rounded-lg px-1 py-1 text-left text-xs text-text-muted hover:bg-bg-sunken">
                      Reset all filters
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setFilter({ playlistId: null, sort: filter.sort === 'playlist' ? 'modified' : filter.sort })}
                className={`rounded-lg px-2.5 py-1 text-xs ${!filter.playlistId ? 'bg-accent/12 text-accent ring-1 ring-accent/30' : 'border border-border text-text-muted hover:text-text'}`}
              >
                All characters
              </button>
              {playlists.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setFilter({ playlistId: p.id === filter.playlistId ? null : p.id })}
                  onDoubleClick={() => setDialog({ kind: 'playlist', playlist: p })}
                  title="Click to filter, double-click to edit"
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs ${
                    filter.playlistId === p.id ? 'bg-accent/12 text-accent ring-1 ring-accent/30' : 'border border-border text-text-muted hover:text-text'
                  }`}
                >
                  <PlaylistIcon playlist={p} size={12} />
                  {p.name}
                  <span className="opacity-60">{p.characterIds.length}</span>
                </button>
              ))}
              {activePlaylist && (
                <button type="button" title="Edit playlist" onClick={() => setDialog({ kind: 'playlist', playlist: activePlaylist })} className="p-1 text-text-muted hover:text-text">
                  <Pencil size={12} />
                </button>
              )}
              <button type="button" onClick={() => setDialog({ kind: 'playlist' })} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-muted hover:text-text">
                <Plus size={12} /> Playlist
              </button>
            </div>

            {allTags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {showAllTags && (
                  <input
                    value={tagQuery}
                    onChange={(e) => setTagQuery(e.target.value)}
                    placeholder="Find tag"
                    className="w-28 rounded-lg bg-bg-sunken px-2 py-0.5 text-xs text-text outline-none"
                  />
                )}
                {visibleTags.map((t) => {
                  const state = tagState[t.key]
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setFilter({ tagFilter: cycleTagState(tagState, t.key) })}
                      title="Click: include → exclude → neutral"
                      className={`rounded-lg px-2 py-0.5 text-xs transition-colors ${
                        state === 'include'
                          ? 'bg-success/15 text-success ring-1 ring-success/40'
                          : state === 'exclude'
                            ? 'bg-danger/15 text-danger line-through ring-1 ring-danger/40'
                            : 'bg-bg-sunken text-text-muted hover:text-text'
                      }`}
                    >
                      {state === 'include' ? '+ ' : state === 'exclude' ? '− ' : ''}
                      {t.tag} <span className="opacity-50">{t.count}</span>
                    </button>
                  )
                })}
                {allTags.length > 24 && (
                  <button type="button" onClick={() => setShowAllTags((v) => !v)} className="px-1 text-xs text-accent">
                    {showAllTags ? 'Fewer' : `All ${allTags.length} tags`}
                  </button>
                )}
                {activeTagCount > 0 && (
                  <>
                    <span className="ml-2 text-[11px] text-text-muted">include</span>
                    <SegmentedControl
                      size="sm"
                      value={filter.includeMode}
                      onChange={(v) => setFilter({ includeMode: v })}
                      options={[
                        { value: 'any', label: 'Any' },
                        { value: 'all', label: 'All' },
                      ]}
                    />
                    <span className="text-[11px] text-text-muted">exclude</span>
                    <SegmentedControl
                      size="sm"
                      value={filter.excludeMode}
                      onChange={(v) => setFilter({ excludeMode: v })}
                      options={[
                        { value: 'any', label: 'Any' },
                        { value: 'all', label: 'All' },
                      ]}
                    />
                    <button type="button" onClick={() => setFilter({ tagFilter: {} })} className="px-1 text-xs text-text-muted hover:text-text">
                      Clear tags
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="text-xs text-text-muted">
              {results.length === list.length ? `${list.length} characters` : `${results.length} of ${list.length} characters`}
              {selectMode && ` · ${selected.size} selected (click, Shift-click for a range, Esc to exit)`}
            </div>
          </div>

          {characters && list.length === 0 ? (
            <div className="px-6">
              <EmptyState
                action={
                  <div className="flex gap-2">
                    <Button onClick={() => setDialog({ kind: 'import' })}>Import cards</Button>
                    <Button variant="primary" onClick={() => setView('online')}>
                      Browse online
                    </Button>
                  </div>
                }
              >
                Your library is empty. Import SillyTavern cards or bundles, or find characters online.
              </EmptyState>
            </div>
          ) : results.length === 0 && characters ? (
            <div className="px-6">
              <EmptyState action={<Button onClick={store.resetFilter}>Reset filters</Button>}>No characters match these filters.</EmptyState>
            </div>
          ) : (
            <LibraryGrid
              entries={results}
              cardWidth={store.cardWidth}
              hover={store.hover}
              selectMode={selectMode}
              selected={selected}
              scrollToId={openId}
              onOpen={(id) => onEditCharacter(id)}
              onOpenDetails={(id) => open(id)}
              onOpenChatForCharacter={onOpenChatForCharacter}
              onToggleSelect={toggleSelect}
              onContextMenu={(id, x, y) => setMenu({ id, x, y })}
              onToggleFavorite={toggleFavorite}
            />
          )}

          {selectMode && (
            <div className="themed-shadow mx-auto mb-3 flex shrink-0 flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-bg-elevated px-3 py-2">
              <span className="px-1 text-sm text-text">{selected.size} selected</span>
              <Button variant="ghost" onClick={() => setSelected(new Set(results.map((e) => e.id)))}>
                All {results.length}
              </Button>
              <Button variant="ghost" disabled={!selected.size} onClick={() => setSelected(new Set())}>
                None
              </Button>
              <span className="mx-1 h-5 w-px bg-border" />
              <Button disabled={!selected.size} onClick={() => setDialog({ kind: 'batchTags', ids: selectedIds })}>
                Tags
              </Button>
              <Button disabled={!selected.size} onClick={() => void setFavoriteMany(selectedIds, true)}>
                Favorite
              </Button>
              <Button disabled={!selected.size} onClick={() => void setFavoriteMany(selectedIds, false)}>
                Unfavorite
              </Button>
              <Button disabled={!selected.size} onClick={() => setDialog({ kind: 'addToPlaylist', ids: selectedIds })}>
                Add to playlist
              </Button>
              <Button disabled={!selected.size} onClick={() => setDialog({ kind: 'updates', ids: selectedIds })}>
                Check updates
              </Button>
              <Button disabled={!selected.size} onClick={() => setDialog({ kind: 'export', ids: selectedIds })}>
                Export
              </Button>
              <Button variant="danger" disabled={!selected.size} onClick={() => void deleteIds(selectedIds)}>
                Delete
              </Button>
              <Button variant="ghost" onClick={exitSelect} aria-label="Exit multi-select">
                <X size={15} />
              </Button>
            </div>
          )}
        </>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}

      {openCharacter && (
        <CharacterDetailsModal
          key={openCharacter.id}
          character={openCharacter}
          characters={list}
          allTags={tagNames}
          userName={userName}
          initialTab={openTab}
          onPrev={openIndex > 0 ? () => open(results[openIndex - 1].id, openTab === 'edit' ? 'details' : openTab) : undefined}
          onNext={openIndex >= 0 && openIndex < results.length - 1 ? () => open(results[openIndex + 1].id, openTab === 'edit' ? 'details' : openTab) : undefined}
          onClose={() => setOpenId(null)}
          onOpenCharacter={(id) => open(id)}
          onOpenChat={onOpenChat}
          onOpenFullEditor={onEditCharacter}
          onFilterTag={(tag) => {
            setOpenId(null)
            setView('library')
            setFilter({ tagFilter: { [tag.toLowerCase()]: 'include' } })
          }}
          onFilterCreator={(creator) => {
            setOpenId(null)
            setView('library')
            setFilter({ search: `creator:"${creator}"`, fields: { ...filter.fields, creator: true } })
          }}
        />
      )}

      {dialog?.kind === 'batchTags' && (
        <BatchTagDialog characters={dialog.ids.map((id) => byId.get(id)).filter((c): c is Character => !!c)} allTags={tagNames} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'export' && (
        <ExportDialog characters={dialog.ids.map((id) => byId.get(id)).filter((c): c is Character => !!c)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'addToPlaylist' && <AddToPlaylistDialog characterIds={dialog.ids} playlists={playlists} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'updates' && (
        <CardUpdatesDialog characters={dialog.ids.map((id) => byId.get(id)).filter((c): c is Character => !!c)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'playlist' && (
        <PlaylistDialog
          playlist={dialog.playlist}
          characters={list}
          initialMembers={dialog.members ?? (dialog.playlist ? undefined : selectedChars.map((c) => c.id))}
          onClose={() => setDialog(null)}
          onSaved={(p) => setFilter({ playlistId: p.id })}
        />
      )}
      {dialog?.kind === 'link' && byId.get(dialog.id) && <LinkProviderDialog character={byId.get(dialog.id)!} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'tags' && (
        <TagsManagerDialog onClose={() => setDialog(null)} onFilterTag={(tag) => setFilter({ tagFilter: { [tag.toLowerCase()]: 'include' } })} />
      )}
      {dialog?.kind === 'duplicates' && <DuplicatesDialog characters={list} onOpen={(id) => open(id)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'settings' && <LibrarySettingsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'recommender' && <RecommenderPanel characters={list} onOpen={(id) => open(id)} onClose={() => setDialog(null)} />}
    </div>
  )
}
