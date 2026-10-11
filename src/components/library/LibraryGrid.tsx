import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Check, Heart, Info, Link2, MessageSquare, Trash2 } from 'lucide-react'
import type { LibraryEntry } from '@/lib/library/search'
import type { HoverOptions } from '@/lib/library/store'
import { PROVIDER_LABELS } from '@/lib/library/links'

const GAP = 14
/** Name + creator lines under the portrait. */
const CAPTION_HEIGHT = 46
const OVERSCAN_ROWS = 3

interface CardProps {
  entry: LibraryEntry
  width: number
  hover: HoverOptions
  selectMode: boolean
  selected: boolean
  onOpen: (id: string) => void
  onToggleSelect: (id: string, range: boolean) => void
  onContextMenu: (id: string, x: number, y: number) => void
  onToggleFavorite: (id: string) => void
  onDelete?: (id: string) => void
  onOpenDetails?: (id: string) => void
  onOpenChatForCharacter?: (id: string) => void
}

const LibraryCard = memo(function LibraryCard({
  entry,
  width,
  hover,
  selectMode,
  selected,
  onOpen,
  onToggleSelect,
  onContextMenu,
  onToggleFavorite,
  onDelete,
  onOpenDetails,
  onOpenChatForCharacter,
}: CardProps) {
  const c = entry.character
  const click = (e: MouseEvent) => {
    if (selectMode || e.ctrlKey || e.metaKey || e.shiftKey) onToggleSelect(entry.id, e.shiftKey)
    else onOpen(entry.id)
  }
  const showInfo = hover.tags || hover.creator || hover.tokens || hover.chats || hover.notes
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={click}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(entry.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(entry.id, e.clientX, e.clientY)
      }}
      style={{ width }}
      className={`themed-shadow group relative cursor-pointer rounded-2xl bg-bg-elevated p-2 text-left outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent/50 ${
        selected ? 'ring-2 ring-accent' : ''
      }`}
    >
      <div className="portrait-frame relative aspect-[3/4] w-full overflow-hidden rounded-xl">
        {c.avatarDataUrl ? (
          <img src={c.avatarDataUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-bg-sunken text-2xl text-text-muted">
            {entry.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        {(selectMode || selected) && (
          <span
            className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border ${
              selected ? 'border-accent bg-accent text-accent-text' : 'border-white/70 bg-black/30'
            }`}
          >
            {selected && <Check size={13} strokeWidth={3} />}
          </span>
        )}
        {onOpenChatForCharacter && !selectMode && !selected && (
          <button
            type="button"
            title="Open in chat"
            aria-label="Open in chat"
            onClick={(e) => {
              e.stopPropagation()
              onOpenChatForCharacter(entry.id)
            }}
            className="absolute left-2 top-2 rounded-full bg-black/40 p-1 text-white/80 opacity-0 transition-all hover:bg-black/70 hover:text-white group-hover:opacity-100"
          >
            <MessageSquare size={14} />
          </button>
        )}
        <div className="absolute right-2 top-2 flex items-center gap-1">
          {onDelete && (
            <button
              type="button"
              title="Delete character"
              aria-label="Delete character"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(entry.id)
              }}
              className="rounded-full bg-black/40 p-1 text-white/80 opacity-0 transition-all hover:bg-danger hover:text-white group-hover:opacity-100"
            >
              <Trash2 size={14} />
            </button>
          )}
          {onOpenDetails && (
            <button
              type="button"
              title="Character details & versions"
              aria-label="Character details & versions"
              onClick={(e) => {
                e.stopPropagation()
                onOpenDetails(entry.id)
              }}
              className="rounded-full bg-black/40 p-1 text-white/80 opacity-0 transition-all hover:bg-black/70 hover:text-white group-hover:opacity-100"
            >
              <Info size={14} />
            </button>
          )}
          <button
            type="button"
            title={entry.favorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={entry.favorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleFavorite(entry.id)
            }}
            className={`rounded-full bg-black/35 p-1 transition-opacity ${
              entry.favorite ? 'text-romance opacity-100' : 'text-white opacity-0 group-hover:opacity-100'
            }`}
          >
            <Heart size={14} fill={entry.favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
        {entry.link && (
          <span title={`Linked to ${PROVIDER_LABELS[entry.link.provider]}`} className="absolute bottom-2 right-2 rounded-full bg-black/45 p-1 text-white">
            <Link2 size={12} />
          </span>
        )}
        {showInfo && (
          // The animated hover card: slides up over the lower half of the portrait.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-full bg-gradient-to-t from-black/90 via-black/75 to-transparent px-2 pb-2 pt-6 text-[11px] leading-snug text-white opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
            {hover.creator && entry.character.card.creator && <div className="truncate opacity-90">by {entry.character.card.creator}</div>}
            {(hover.tokens || hover.chats) && (
              <div className="flex gap-2 opacity-80">
                {hover.tokens && <span>~{entry.tokens.toLocaleString()} tok</span>}
                {hover.chats && entry.chats > 0 && (
                  <span className="flex items-center gap-0.5">
                    <MessageSquare size={10} /> {entry.chats} · {entry.messages} msgs
                  </span>
                )}
              </div>
            )}
            {hover.notes && entry.lowerNotes && (
              <div className="mt-0.5 line-clamp-3 opacity-80">{entry.character.card.creator_notes?.replace(/<[^>]+>/g, ' ').slice(0, 200)}</div>
            )}
            {hover.tags && entry.tags.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {entry.tags.slice(0, 6).map((t) => (
                  <span key={t} className="rounded bg-white/15 px-1">
                    {t}
                  </span>
                ))}
                {entry.tags.length > 6 && <span className="opacity-70">+{entry.tags.length - 6}</span>}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-1.5 truncate px-1 text-sm font-medium text-text">{entry.name}</div>
      <div className="truncate px-1 text-xs text-text-muted">{entry.character.card.creator || '\u00a0'}</div>
    </div>
  )
})

/**
 * Virtual-scrolling card grid: only the rows in (or just around) the viewport are mounted, so a
 * library of thousands of cards scrolls as cheaply as one of twenty. Columns are fitted to the
 * container width from the preferred `cardWidth`; portraits load lazily as rows mount.
 */
export function LibraryGrid({
  entries,
  cardWidth,
  scrollToId,
  selected,
  ...cardProps
}: Omit<CardProps, 'entry' | 'width' | 'selected'> & {
  entries: LibraryEntry[]
  cardWidth: number
  selected: Set<string>
  /** Scrolls this card into view when it changes (e.g. after prev/next in the details modal). */
  scrollToId?: string | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })

  useLayoutEffect(() => {
    const el = scrollRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    // Width comes from the padded inner box, the viewport from the scroller itself.
    const measure = () => {
      setWidth(inner.clientWidth)
      setViewport({ top: el.scrollTop, height: el.clientHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  const columns = Math.max(1, Math.floor((width + GAP) / (cardWidth + GAP)))
  const itemWidth = width ? Math.floor((width - GAP * (columns - 1)) / columns) : cardWidth
  const rowHeight = Math.round((itemWidth - 16) * (4 / 3)) + 16 + CAPTION_HEIGHT + GAP
  const rowCount = Math.ceil(entries.length / columns)
  const firstRow = Math.max(0, Math.floor(viewport.top / rowHeight) - OVERSCAN_ROWS)
  const lastRow = Math.min(rowCount - 1, Math.ceil((viewport.top + viewport.height) / rowHeight) + OVERSCAN_ROWS)

  useEffect(() => {
    if (!scrollToId || !scrollRef.current) return
    const index = entries.findIndex((e) => e.id === scrollToId)
    if (index < 0) return
    const rowTop = Math.floor(index / columns) * rowHeight
    const el = scrollRef.current
    if (rowTop < el.scrollTop || rowTop + rowHeight > el.scrollTop + el.clientHeight) el.scrollTo({ top: Math.max(0, rowTop - rowHeight) })
  }, [scrollToId])

  const rows = []
  for (let r = firstRow; r <= lastRow; r++) {
    const slice = entries.slice(r * columns, r * columns + columns)
    rows.push(
      <div key={r} className="absolute left-0 flex" style={{ top: r * rowHeight, gap: GAP }}>
        {slice.map((entry) => (
          <LibraryCard key={entry.id} entry={entry} width={itemWidth} selected={selected.has(entry.id)} {...cardProps} />
        ))}
      </div>,
    )
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6"
    >
      <div ref={innerRef} className="relative" style={{ height: rowCount * rowHeight }}>
        {rows}
      </div>
    </div>
  )
}
