import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BookText,
  ChevronLeft,
  ChevronRight,
  GitCompare,
  Heart,
  History,
  Images,
  Info,
  Link2,
  MessagesSquare,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import type { Character } from '@/lib/characters/cardSpec'
import { charactersApi } from '@/lib/api/client'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import { libraryApi } from '@/lib/library/api'
import { displayNameOf, getProviderLink, isFavorite, PROVIDER_LABELS } from '@/lib/library/links'
import { useLibraryStore } from '@/lib/library/store'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError } from '@/lib/store/useToastStore'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { TabRail, type TabRailItem } from '@/components/ui/TabRail'
import { DetailsTab } from './details/DetailsTab'
import { EditTab } from './details/EditTab'
import { ChatsTab } from './details/ChatsTab'
import { RelatedTab } from './details/RelatedTab'
import { VersionsTab } from './details/VersionsTab'
import { GalleryTab } from './gallery/GalleryTab'
import { LinkProviderDialog } from './LinkProviderDialog'
import { CardUpdatesDialog } from './CardUpdatesDialog'

export type DetailsTabId = 'details' | 'edit' | 'chats' | 'gallery' | 'related' | 'versions' | 'info'

function HeaderButton({ title, onClick, children, active }: { title: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`rounded-lg p-2 transition-colors hover:bg-bg-sunken ${active ? 'text-romance' : 'text-text-muted hover:text-text'}`}
    >
      {children}
    </button>
  )
}

/**
 * The library's character details: a wide modal with Details / Edit / Chats / Gallery / Related /
 * Versions (and optional Info) tabs, prev/next through the current filtered+sorted grid, and an
 * unsaved-edits guard on every way out (close, Escape, prev/next, opening another character).
 */
export function CharacterDetailsModal({
  character,
  characters,
  allTags,
  userName,
  initialTab = 'details',
  onPrev,
  onNext,
  onClose,
  onOpenCharacter,
  onOpenChat,
  onOpenFullEditor,
  onFilterTag,
  onFilterCreator,
}: {
  character: Character
  characters: Character[]
  allTags: string[]
  userName: string
  initialTab?: DetailsTabId
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
  onOpenCharacter: (id: string) => void
  onOpenChat: (chatId: string) => void
  onOpenFullEditor: (id: string) => void
  onFilterTag: (tag: string) => void
  onFilterCreator: (creator: string) => void
}) {
  const [tab, setTab] = useState<DetailsTabId>(initialTab)
  const [dirty, setDirty] = useState(false)
  const [linking, setLinking] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const prevNextNav = useLibraryStore((s) => s.prevNextNav)
  const showInfoTab = useLibraryStore((s) => s.showInfoTab)
  const localizeMedia = useLibraryStore((s) => s.localizeMedia)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  const card = character.card
  const name = displayNameOf(card)
  const favorite = isFavorite(card)
  const link = getProviderLink(card)
  const localize = useApiQuery('library-media', () => libraryApi.localization(character.id), [character.id])
  const names = useMemo(() => ({ char: card.name, user: userName }), [card.name, userName])

  /** Runs `action` only after confirming that unsaved Edit-tab changes may be thrown away. */
  const guard = async (action: () => void) => {
    if (
      dirty &&
      !(await confirmDialog({
        title: 'Discard unsaved edits?',
        body: `Your changes to ${card.name} in the Edit tab haven't been saved.`,
        confirmLabel: 'Discard',
        tone: 'danger',
      }))
    ) {
      return
    }
    setDirty(false)
    action()
  }

  // Keyboard: Escape closes, ←/→ step through the grid — but only when this is the top dialog and
  // focus isn't in a text field.
  const handlers = useRef({ guard, onClose, onPrev, onNext })
  handlers.current = { guard, onClose, onPrev, onNext }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelectorAll('[role="dialog"]').length > 1) return
      const t = e.target as HTMLElement | null
      const typing = t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || t?.isContentEditable
      const h = handlers.current
      if (e.key === 'Escape') void h.guard(h.onClose)
      else if (!typing && e.key === 'ArrowLeft' && h.onPrev) void h.guard(h.onPrev)
      else if (!typing && e.key === 'ArrowRight' && h.onNext) void h.guard(h.onNext)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleFavorite = () => libraryApi.batch([character.id], { action: 'setFavorite', value: !favorite }).catch((e) => toastError(errorMessage(e)))

  const saveDisplayName = async (value: string) => {
    setEditingName(null)
    if (value.trim() === name || (!value.trim() && name === card.name)) return
    await libraryApi.batch([character.id], { action: 'setDisplayName', value: value.trim() === card.name ? '' : value })
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete ${card.name}?`,
      body: 'Their chats, media, snapshots and sprites are deleted too. This cannot be undone.',
      confirmLabel: 'Delete character',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await charactersApi.remove(character.id)
      setDirty(false)
      onClose()
    } catch (e) {
      toastError(errorMessage(e))
    }
  }

  const tabs: TabRailItem<DetailsTabId>[] = [
    { id: 'details', label: 'Details', icon: BookText },
    { id: 'edit', label: 'Edit', icon: Pencil, badge: dirty ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : undefined },
    { id: 'chats', label: 'Chats', icon: MessagesSquare },
    { id: 'gallery', label: 'Gallery', icon: Images },
    { id: 'related', label: 'Related', icon: GitCompare },
    { id: 'versions', label: 'Versions', icon: History },
    ...(showInfoTab ? [{ id: 'info' as const, label: 'Info', icon: Info }] : []),
  ]

  return (
    <div className="animate-overlay-in fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4" onClick={() => void guard(onClose)}>
      {prevNextNav && onPrev && (
        <button
          type="button"
          aria-label="Previous character"
          onClick={(e) => {
            e.stopPropagation()
            void guard(onPrev)
          }}
          className="absolute left-2 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-bg-elevated/80 p-2 text-text-muted shadow-lg hover:text-text lg:block"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {prevNextNav && onNext && (
        <button
          type="button"
          aria-label="Next character"
          onClick={(e) => {
            e.stopPropagation()
            void guard(onNext)
          }}
          className="absolute right-2 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-bg-elevated/80 p-2 text-text-muted shadow-lg hover:text-text lg:block"
        >
          <ChevronRight size={22} />
        </button>
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="animate-panel-in themed-shadow flex h-full w-full max-w-5xl flex-col overflow-hidden border border-border bg-bg sm:h-[90vh] sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border bg-bg-elevated px-4 py-3 sm:px-5">
          <div className="h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-bg-sunken sm:h-20 sm:w-16">
            {character.avatarDataUrl && <img src={character.avatarDataUrl} alt="" className="h-full w-full object-cover object-top" />}
          </div>
          <div className="min-w-0 flex-1">
            {editingName !== null ? (
              <input
                autoFocus
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={() => saveDisplayName(editingName)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setEditingName(null)
                  }
                }}
                placeholder={card.name}
                className="w-full rounded-lg bg-bg-sunken px-2 py-1 font-display text-lg text-text outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingName(name)}
                title="Set a display name for the library (the card's own name is kept)"
                className="block max-w-full truncate text-left font-display text-lg text-text hover:text-accent"
              >
                {name}
              </button>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-text-muted">
              {name !== card.name && <span>Card name: {card.name}</span>}
              {card.creator && <span>by {card.creator}</span>}
              {link && (
                <span className="flex items-center gap-1 text-accent">
                  <Link2 size={11} /> {PROVIDER_LABELS[link.provider]}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center">
            <HeaderButton title={favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={toggleFavorite} active={favorite}>
              <Heart size={17} fill={favorite ? 'currentColor' : 'none'} />
            </HeaderButton>
            <HeaderButton title={link ? 'Provider link' : 'Link to an online source'} onClick={() => setLinking(true)}>
              <Link2 size={17} />
            </HeaderButton>
            {link && (
              <HeaderButton title="Check for card updates" onClick={() => setCheckingUpdates(true)}>
                <RefreshCw size={17} />
              </HeaderButton>
            )}
            <HeaderButton title="Chats" onClick={() => setTab('chats')}>
              <MessagesSquare size={17} />
            </HeaderButton>
            <HeaderButton title="Delete character" onClick={remove}>
              <Trash2 size={17} />
            </HeaderButton>
            <HeaderButton title="Close" onClick={() => void guard(onClose)}>
              <X size={18} />
            </HeaderButton>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 px-3 pt-3 sm:px-5">
          {prevNextNav && (
            <button type="button" disabled={!onPrev} aria-label="Previous character" onClick={() => onPrev && void guard(onPrev)} className="rounded-lg p-1.5 text-text-muted hover:bg-bg-sunken disabled:opacity-30 lg:hidden">
              <ChevronLeft size={18} />
            </button>
          )}
          <TabRail items={tabs} value={tab} onChange={setTab} className="flex-1 overflow-x-auto" />
          {prevNextNav && (
            <button type="button" disabled={!onNext} aria-label="Next character" onClick={() => onNext && void guard(onNext)} className="rounded-lg p-1.5 text-text-muted hover:bg-bg-sunken disabled:opacity-30 lg:hidden">
              <ChevronRight size={18} />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {tab === 'details' && (
            <DetailsTab
              character={character}
              names={names}
              localize={localizeMedia ? localize : undefined}
              onTagClick={(t) => void guard(() => onFilterTag(t))}
              onCreatorClick={(c) => void guard(() => onFilterCreator(c))}
            />
          )}
          {/* Kept mounted once opened so switching tabs doesn't throw away an unsaved draft. */}
          <div hidden={tab !== 'edit'}>
            <EditTab
              character={character}
              allTags={allTags}
              onDirtyChange={setDirty}
              onOpenFullEditor={() => void guard(() => onOpenFullEditor(character.id))}
            />
          </div>
          {tab === 'chats' && <ChatsTab character={character} onOpenChat={(id) => void guard(() => onOpenChat(id))} />}
          {tab === 'gallery' && <GalleryTab character={character} />}
          {tab === 'related' && <RelatedTab character={character} characters={characters} onOpen={(id) => void guard(() => onOpenCharacter(id))} />}
          {tab === 'versions' && <VersionsTab character={character} />}
          {tab === 'info' && (
            <pre className="overflow-auto whitespace-pre-wrap break-all rounded-xl bg-bg-sunken p-3 font-mono text-[11px] text-text-muted">
              {JSON.stringify(
                {
                  id: character.id,
                  createdAt: new Date(character.createdAt).toISOString(),
                  updatedAt: new Date(character.updatedAt).toISOString(),
                  avatar: character.avatarDataUrl,
                  worldId: character.worldId,
                  sprites: Object.keys(character.sprites ?? {}).length,
                  cgGallery: character.gallery?.length ?? 0,
                  link,
                  extensions: card.extensions,
                  lorebookEntries: card.character_book?.entries.length ?? 0,
                },
                null,
                2,
              )}
            </pre>
          )}
        </div>
      </div>

      {linking && (
        <div onClick={(e) => e.stopPropagation()}>
          <LinkProviderDialog character={character} onClose={() => setLinking(false)} />
        </div>
      )}
      {checkingUpdates && (
        <div onClick={(e) => e.stopPropagation()}>
          <CardUpdatesDialog characters={[character]} onClose={() => setCheckingUpdates(false)} />
        </div>
      )}
    </div>
  )
}
