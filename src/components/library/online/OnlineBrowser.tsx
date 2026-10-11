import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Check, Download, Heart, Link2, Loader2, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import type { Character } from '@/lib/characters/cardSpec'
import { onlineApi } from '@/lib/library/api'
import { PROVIDER_LABELS } from '@/lib/library/links'
import { importOnlineCharacter, linkKey, localLinkIndex } from '@/lib/library/onlineImport'
import type { OnlineCharacterSummary, OnlineSort, ProviderId } from '@/lib/library/types'
import { errorMessage } from '@/lib/store/useToastStore'
import { OnlinePreview, formatCount } from './OnlinePreview'

const STORAGE_KEY = 'rp-library-online'

/** Each catalog's own sort orders, mapped server-side; only the ones a provider really has are offered. */
const PROVIDER_SORTS: Record<ProviderId, OnlineSort[]> = {
  chub: ['popular', 'downloads', 'rating', 'newest', 'updated', 'random'],
  wyvern: ['popular', 'rating', 'newest'],
  chartavern: ['popular', 'rating', 'newest'],
  botbooru: ['popular', 'downloads', 'rating', 'newest', 'random'],
}

const SORT_LABELS: Record<OnlineSort, string> = {
  popular: 'Popular',
  downloads: 'Most downloaded',
  rating: 'Top rated',
  newest: 'Newest',
  updated: 'Recently updated',
  random: 'Random',
}

const PROVIDER_NOTES: Partial<Record<ProviderId, string>> = {
  chartavern: 'CharacterTavern only shows NSFW cards to logged-in sessions, so browsing here is effectively SFW.',
  botbooru: 'Anonymous Botbooru browsing is SFW-only. Tags use underscores (e.g. long_hair).',
  wyvern: 'Wyvern limits anonymous NSFW results; a creator filter lists that creator’s characters on one page.',
}

const PROVIDERS = Object.keys(PROVIDER_SORTS) as ProviderId[]

interface Prefs {
  provider: ProviderId
  sort: OnlineSort
  nsfw: boolean
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { provider: 'chub', sort: 'popular', nsfw: false }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Prefs>
    const provider = PROVIDERS.includes(raw.provider as ProviderId) ? (raw.provider as ProviderId) : fallback.provider
    const sort = PROVIDER_SORTS[provider].includes(raw.sort as OnlineSort) ? (raw.sort as OnlineSort) : fallback.sort
    return { provider, sort, nsfw: raw.nsfw === true }
  } catch {
    return fallback
  }
}

interface Filters {
  query: string
  tags: string[]
  excludeTags: string[]
  creator: string
}

interface LogLine {
  url: string
  status: 'ok' | 'skip' | 'error'
  text: string
}

/** Paste-links batch import: one provider URL per line, resolved and imported in order. */
function LinkImporter({ characters, onOpenLocal }: { characters: Character[]; onOpenLocal: (id: string) => void }) {
  const [text, setText] = useState('')
  const [withGallery, setWithGallery] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number }>()
  const [log, setLog] = useState<(LogLine & { id?: string })[]>([])

  const run = async () => {
    const urls = [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))]
    if (!urls.length) return
    setRunning(true)
    setLog([])
    setProgress({ done: 0, total: urls.length })
    const owned = localLinkIndex(characters)
    for (const [i, url] of urls.entries()) {
      let line: LogLine & { id?: string }
      try {
        const { provider, id } = await onlineApi.resolveUrl(url)
        const existing = owned.get(linkKey(provider, id))
        if (existing) {
          line = { url, status: 'skip', text: `Already in library as "${existing.card.name}"`, id: existing.id }
        } else {
          const detail = await onlineApi.character(provider, id)
          const created = await importOnlineCharacter(detail, { downloadGallery: withGallery })
          owned.set(linkKey(provider, id), created)
          line = { url, status: 'ok', text: `Imported "${created.card.name}" from ${PROVIDER_LABELS[provider]}`, id: created.id }
        }
      } catch (e) {
        line = { url, status: 'error', text: errorMessage(e) }
      }
      setLog((prev) => [...prev, line])
      setProgress({ done: i + 1, total: urls.length })
    }
    setRunning(false)
  }

  return (
    <div className="mb-4 space-y-2 rounded-2xl border border-border bg-bg-elevated p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={'One character link per line, e.g.\nhttps://chub.ai/characters/creator/name\nhttps://app.wyvern.chat/characters/…'}
        className="w-full resize-y rounded-xl bg-bg-sunken px-3 py-2 font-mono text-xs text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={running || !text.trim()} onClick={() => void run()}>
          {running ? 'Importing…' : 'Import links'}
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input type="checkbox" checked={withGallery} onChange={(e) => setWithGallery(e.target.checked)} className="accent-[rgb(var(--c-accent))]" />
          Also download provider galleries
        </label>
        {progress && (
          <span className="text-xs text-text-muted">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>
      {log.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
          {log.map((l, i) => (
            <li key={`${i}-${l.url}`} className="flex items-start gap-2">
              {l.status === 'ok' ? (
                <Check size={13} className="mt-0.5 shrink-0 text-accent" />
              ) : l.status === 'skip' ? (
                <Link2 size={13} className="mt-0.5 shrink-0 text-text-muted" />
              ) : (
                <X size={13} className="mt-0.5 shrink-0 text-danger" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-text-muted">{l.url}</span>
                <span className={l.status === 'error' ? 'text-danger' : 'text-text'}>{l.text}</span>
              </span>
              {l.id && (
                <button type="button" className="shrink-0 text-accent hover:underline" onClick={() => onOpenLocal(l.id!)}>
                  Open
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ResultCard({
  item,
  local,
  onPreview,
  onOpenLocal,
}: {
  item: OnlineCharacterSummary
  local?: Character
  onPreview: (item: OnlineCharacterSummary) => void
  onOpenLocal: (id: string) => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPreview(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onPreview(item)
      }}
      title={item.tagline}
      className="themed-shadow group relative cursor-pointer rounded-2xl bg-bg-elevated p-2 text-left outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <div className="portrait-frame relative aspect-[3/4] w-full overflow-hidden rounded-xl bg-bg-sunken">
        {item.avatarUrl && <img src={item.avatarUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />}
        {item.nsfw && <span className="absolute left-2 top-2 rounded bg-danger/85 px-1.5 text-[10px] font-semibold text-white">NSFW</span>}
        {local && (
          <button
            type="button"
            title={`Open "${local.card.name}" in your library`}
            onClick={(e) => {
              e.stopPropagation()
              onOpenLocal(local.id)
            }}
            className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-accent-text"
          >
            <Check size={11} strokeWidth={3} /> In library
          </button>
        )}
        {(item.downloads !== undefined || item.likes !== undefined || item.tokens !== undefined) && (
          <div className="absolute inset-x-0 bottom-0 flex gap-2 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-5 text-[10px] text-white">
            {item.downloads !== undefined && (
              <span className="flex items-center gap-0.5">
                <Download size={10} /> {formatCount(item.downloads)}
              </span>
            )}
            {item.likes !== undefined && (
              <span className="flex items-center gap-0.5">
                <Heart size={10} /> {formatCount(item.likes)}
              </span>
            )}
            {item.tokens !== undefined && <span className="ml-auto">{formatCount(item.tokens)} tok</span>}
          </div>
        )}
      </div>
      <div className="mt-1.5 truncate px-1 text-sm font-medium text-text">{item.name}</div>
      <div className="truncate px-1 text-xs text-text-muted">{item.creator || '\u00a0'}</div>
      {item.tags.length > 0 && (
        <div className="mt-1 flex gap-1 overflow-hidden px-1">
          {item.tags.slice(0, 3).map((t) => (
            <span key={t} className="shrink-0 rounded bg-bg-sunken px-1.5 text-[10px] text-text-muted">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Browse/search an online catalog and import from it. Results page in as the end of the grid
 * scrolls into view; anything already linked to a library character is badged (or hidden).
 */
export function OnlineBrowser({ characters, onOpenLocal }: { characters: Character[]; onOpenLocal: (id: string) => void }) {
  const [prefs, setPrefs] = useState(loadPrefs)
  const { provider, sort, nsfw } = prefs
  const [draft, setDraft] = useState({ query: '', tags: '', excludeTags: '', creator: '' })
  const [filters, setFilters] = useState<Filters>({ query: '', tags: [], excludeTags: [], creator: '' })
  const [hideOwned, setHideOwned] = useState(false)
  const [showLinks, setShowLinks] = useState(false)
  const [preview, setPreview] = useState<OnlineCharacterSummary>()

  const [items, setItems] = useState<OnlineCharacterSummary[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState<number>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  /** Bumped whenever the search changes, so a slow response for an old search is dropped. */
  const generation = useRef(0)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  }, [prefs])

  const owned = useMemo(() => localLinkIndex(characters), [characters])

  const loadPage = useCallback(
    async (next: number) => {
      const gen = generation.current
      setLoading(true)
      setError(undefined)
      try {
        const result = await onlineApi.search(provider, { ...filters, sort, nsfw, page: next })
        if (gen !== generation.current) return
        setItems((prev) => {
          if (next === 1) return result.items
          const seen = new Set(prev.map((i) => i.id))
          return [...prev, ...result.items.filter((i) => !seen.has(i.id))]
        })
        setPage(next)
        setHasMore(result.hasMore)
        setTotal(result.total)
      } catch (e) {
        if (gen === generation.current) {
          setError(errorMessage(e))
          setHasMore(false)
        }
      } finally {
        if (gen === generation.current) setLoading(false)
      }
    },
    [provider, filters, sort, nsfw],
  )

  useEffect(() => {
    generation.current++
    setItems([])
    setPage(0)
    setHasMore(false)
    setTotal(undefined)
    void loadPage(1)
  }, [loadPage])

  // Infinite scroll: whenever the sentinel under the grid is near the viewport, fetch the next page.
  // Re-armed after each load, so a page mostly hidden by "Hide owned" keeps pulling more.
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || loading) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadPage(page + 1)
    }, { rootMargin: '600px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, page, loadPage])

  const visible = hideOwned ? items.filter((i) => !owned.has(linkKey(i.provider, i.id))) : items

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const [tags, excludeTags] = [draft.tags, draft.excludeTags].map((text) => [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))])
    setFilters({ query: draft.query.trim(), tags, excludeTags, creator: draft.creator.trim() })
  }

  return (
    <div>
      <form onSubmit={submit} className="mb-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={provider}
            onChange={(e) => {
              const next = e.target.value as ProviderId
              setPrefs((p) => ({ ...p, provider: next, sort: PROVIDER_SORTS[next].includes(p.sort) ? p.sort : 'popular' }))
            }}
            aria-label="Provider"
            className="rounded-xl bg-bg-sunken px-3 py-2 text-sm text-text outline-none focus:ring-1 focus:ring-accent/40"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
          <div className="relative min-w-[12rem] flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={draft.query}
              onChange={(e) => setDraft((d) => ({ ...d, query: e.target.value }))}
              placeholder={`Search ${PROVIDER_LABELS[provider]}…`}
              className="w-full rounded-xl bg-bg-sunken py-2 pl-8 pr-3 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as OnlineSort }))}
            aria-label="Sort"
            className="rounded-xl bg-bg-sunken px-3 py-2 text-sm text-text outline-none focus:ring-1 focus:ring-accent/40"
          >
            {PROVIDER_SORTS[provider].map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
          <Button type="submit" variant="primary">
            Search
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {(
            [
              ['tags', 'Include tags (comma-separated)'],
              ['excludeTags', 'Exclude tags'],
              ['creator', 'Creator'],
            ] as const
          ).map(([key, placeholder]) => (
            <input
              key={key}
              value={draft[key]}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full rounded-xl bg-bg-sunken px-3 py-2 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-6">
          <Toggle checked={nsfw} onChange={(v) => setPrefs((p) => ({ ...p, nsfw: v }))} label="NSFW" />
          <Toggle checked={hideOwned} onChange={setHideOwned} label="Hide owned" />
          <Button type="button" variant="ghost" onClick={() => setShowLinks((v) => !v)}>
            {showLinks ? 'Hide link import' : 'Import from links…'}
          </Button>
          {total !== undefined && <span className="text-xs text-text-muted">{total.toLocaleString()} results</span>}
        </div>
        {PROVIDER_NOTES[provider] && <p className="text-xs text-text-muted">{PROVIDER_NOTES[provider]}</p>}
      </form>

      {showLinks && <LinkImporter characters={characters} onOpenLocal={onOpenLocal} />}

      {error && (
        <div className="mb-3 flex items-center gap-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          <span className="flex-1">{error}</span>
          <Button variant="secondary" onClick={() => void loadPage(page + 1)}>
            Retry
          </Button>
        </div>
      )}

      {visible.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {visible.map((item) => (
            <ResultCard key={`${item.provider}:${item.id}`} item={item} local={owned.get(linkKey(item.provider, item.id))} onPreview={setPreview} onOpenLocal={onOpenLocal} />
          ))}
        </div>
      ) : (
        !loading &&
        !error && <EmptyState>{items.length > 0 ? 'Everything on this page is already in your library.' : 'No characters found.'}</EmptyState>
      )}

      <div ref={sentinel} className="flex h-16 items-center justify-center text-sm text-text-muted">
        {loading && (
          <span className="flex items-center gap-2">
            {page === 0 ? <Spinner /> : <Loader2 size={14} className="animate-spin" />} Loading…
          </span>
        )}
        {!loading && !hasMore && items.length > 0 && <span className="text-xs">End of results</span>}
      </div>

      {preview && (
        <OnlinePreview
          summary={preview}
          local={owned.get(linkKey(preview.provider, preview.id))}
          onClose={() => setPreview(undefined)}
          onOpenLocal={onOpenLocal}
        />
      )}
    </div>
  )
}
