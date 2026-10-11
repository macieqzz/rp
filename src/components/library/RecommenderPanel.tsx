import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Dices, ListPlus, RefreshCw, Sparkles, Square, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { NumberField, TextField } from '@/components/ui/Field'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Spinner } from '@/components/ui/Spinner'
import { Toggle } from '@/components/ui/Toggle'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import { useChatBackendClient } from '@/lib/hooks/useChatBackendClient'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'
import { libraryApi } from '@/lib/library/api'
import { displayNameOf } from '@/lib/library/links'
import {
  DEFAULT_CONTEXT_FIELDS,
  buildRecommenderPool,
  estimatePromptTokens,
  runRecommender,
  type Recommendation,
  type RecommenderContextFields,
  type RecommenderFilters,
} from '@/lib/library/aiRecommender'
import type { Character } from '@/lib/characters/cardSpec'

type TriState = 'yes' | 'any' | 'no'

const TRI_OPTIONS: { value: TriState; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'any', label: 'Any' },
  { value: 'no', label: 'No' },
]

const CONTEXT_LABELS: Record<keyof RecommenderContextFields, { label: string; description: string }> = {
  tags: { label: 'Tags', description: 'Cheap and usually the strongest signal.' },
  creator: { label: 'Creator', description: "The card author's name." },
  creatorNotes: { label: 'Creator notes', description: 'Up to 400 characters of the author’s notes.' },
  description: { label: 'Description', description: 'Up to 400 characters each. Costly on big samples.' },
}

const NEW_PLAYLIST = '__new__'

/** A parsed integer clamped to [min, max], or `fallback` for a blank/invalid field. */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(raw))
  return raw.trim() && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

/** `<input type="date">` value → epoch ms at the start (or end) of that local day. */
function dayBound(value: string, end: boolean): number | undefined {
  if (!value) return undefined
  const t = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`).getTime()
  return Number.isFinite(t) ? t : undefined
}

/** What a reroll repeats: the last run's request and settings, so tweaking the form doesn't change it. */
interface RunConfig {
  prompt: string
  pool: Character[]
  sampleSize: number
  maxResults: number
  batchCount: number
  contextFields: RecommenderContextFields
}

/**
 * The LLM Card Recommender: describe what you're in the mood for, and the model picks matching
 * characters from a filtered, sampled slice of the library (`aiRecommender.ts`). Rerolls skip
 * everything already suggested this session; results can be opened or saved as a playlist.
 */
export function RecommenderPanel({
  characters,
  onOpen,
  onClose,
}: {
  characters: Character[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const client = useChatBackendClient()
  const chatStats = useApiQuery(['chats', 'characters'], () => libraryApi.chatStats(), [])
  const playlists = useApiQuery('library-playlists', () => libraryApi.playlists(), []) ?? []

  const [prompt, setPrompt] = useState('')
  const [sampleSize, setSampleSize] = useState('100')
  const [maxResults, setMaxResults] = useState('10')
  const [batchMode, setBatchMode] = useState(false)
  const [batchCount, setBatchCount] = useState('3')
  const [hasChats, setHasChats] = useState<TriState>('any')
  const [favorite, setFavorite] = useState<TriState>('any')
  const [includeTags, setIncludeTags] = useState<string[]>([])
  const [excludeTags, setExcludeTags] = useState<string[]>([])
  const [createdFrom, setCreatedFrom] = useState('')
  const [createdTo, setCreatedTo] = useState('')
  const [contextFields, setContextFields] = useState<RecommenderContextFields>(DEFAULT_CONTEXT_FIELDS)
  const [showSettings, setShowSettings] = useState(true)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [results, setResults] = useState<Recommendation[]>([])
  const [evaluated, setEvaluated] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [lastRun, setLastRun] = useState<RunConfig | null>(null)
  const [shownIds, setShownIds] = useState<Set<string>>(new Set())
  const [playlistTarget, setPlaylistTarget] = useState(NEW_PLAYLIST)
  const [playlistName, setPlaylistName] = useState('')
  const [savingPlaylist, setSavingPlaylist] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters])
  const allTags = useMemo(() => {
    const tags = new Set<string>()
    for (const c of characters) for (const t of c.card.tags ?? []) tags.add(t.trim().toLowerCase())
    return [...tags].filter(Boolean).sort()
  }, [characters])

  // Has-chats filtering needs the stats; until they load, that filter counts as "any".
  const pool = useMemo(() => {
    const filters: RecommenderFilters = {
      hasChats: !chatStats || hasChats === 'any' ? undefined : hasChats === 'yes',
      favorite: favorite === 'any' ? undefined : favorite === 'yes',
      includeTags,
      excludeTags,
      createdAfter: dayBound(createdFrom, false),
      createdBefore: dayBound(createdTo, true),
    }
    return buildRecommenderPool(characters, filters, chatStats ?? {})
  }, [characters, chatStats, hasChats, favorite, includeTags, excludeTags, createdFrom, createdTo])

  const sample = clampInt(sampleSize, 10, 500, 100)
  const batches = batchMode ? clampInt(batchCount, 3, 7, 3) : 1
  const max = clampInt(maxResults, 1, 50, 10)
  const perCall = batchMode ? Math.ceil(Math.min(sample * batches, pool.length) / batches) : Math.min(sample, pool.length)
  const tokenEstimate = useMemo(
    () => estimatePromptTokens(prompt || 'x', pool.slice(0, perCall), contextFields),
    [prompt, pool, perCall, contextFields],
  )

  const execute = async (config: RunConfig, exclude: Set<string>) => {
    if (busy) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    setWarning(null)
    setStatus('')
    try {
      const result = await runRecommender(client, {
        prompt: config.prompt,
        pool: config.pool,
        sampleSize: config.sampleSize,
        maxResults: config.maxResults,
        batchCount: config.batchCount,
        contextFields: config.contextFields,
        excludeIds: exclude,
        signal: controller.signal,
        onProgress: (message) => {
          if (!controller.signal.aborted) setStatus(message)
        },
      })
      if (controller.signal.aborted) return
      setResults(result.recommendations)
      setEvaluated(result.evaluated)
      setWarning(result.warning ?? null)
      setExpanded(new Set())
      setShownIds(new Set([...exclude, ...result.recommendations.map((r) => r.characterId)]))
      setLastRun(config)
      if (window.innerWidth < 640) setShowSettings(false)
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e))
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setBusy(false)
        setStatus('')
      }
    }
  }

  const generate = () => {
    if (!prompt.trim()) return
    execute({ prompt: prompt.trim(), pool, sampleSize: sample, maxResults: max, batchCount: batches, contextFields }, new Set())
  }

  const reroll = () => {
    if (lastRun) execute(lastRun, shownIds)
  }

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setStatus('')
  }

  const toggleExpanded = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const resultIds = results.map((r) => r.characterId).filter((id) => byId.has(id))

  const saveToPlaylist = async () => {
    if (!resultIds.length || savingPlaylist) return
    setSavingPlaylist(true)
    try {
      if (playlistTarget === NEW_PLAYLIST) {
        const name = playlistName.trim() || lastRun?.prompt.slice(0, 60) || 'Recommendations'
        await libraryApi.createPlaylist({ name, characterIds: resultIds })
        toastSuccess(`Created playlist "${name}" with ${resultIds.length} characters.`)
        setPlaylistName('')
      } else {
        const playlist = await libraryApi.playlistMembers(playlistTarget, { add: resultIds })
        toastSuccess(`Added ${resultIds.length} characters to "${playlist.name}".`)
      }
    } catch (e) {
      toastError(`Couldn't save the playlist: ${errorMessage(e)}`)
    } finally {
      setSavingPlaylist(false)
    }
  }

  return (
    <Modal
      title="Card Recommender"
      description="Describe what you're in the mood for and the model picks matching characters from your library."
      size="3xl"
      scrollable
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        <div className="space-y-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                generate()
              }
            }}
            rows={2}
            placeholder='e.g. "cozy fantasy companions", "dark horror villains", "sci-fi androids with deep lore"'
            className="w-full resize-none rounded-xl bg-bg-sunken px-3 py-2 text-sm leading-relaxed text-text outline-none ring-1 ring-transparent transition-shadow placeholder:text-text-muted/55 focus:ring-accent/40"
          />
          <div className="flex flex-wrap items-center gap-2">
            {busy ? (
              <Button variant="danger" onClick={stop}>
                <span className="inline-flex items-center gap-1.5">
                  <Square size={13} /> Stop
                </span>
              </Button>
            ) : (
              <Button variant="primary" onClick={generate} disabled={!prompt.trim() || pool.length === 0}>
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles size={14} /> Generate
                </span>
              </Button>
            )}
            <Button onClick={reroll} disabled={busy || !lastRun} title="Same request and settings, skipping everything already suggested">
              <span className="inline-flex items-center gap-1.5">
                <Dices size={14} /> Reroll
              </span>
            </Button>
            <span className="text-xs text-text-muted">
              {pool.length.toLocaleString()} of {characters.length.toLocaleString()} characters in pool · ~
              {tokenEstimate >= 1000 ? `${(tokenEstimate / 1000).toFixed(1)}k` : tokenEstimate} tokens
              {batchMode ? ` per batch × ${batches} + ranking pass` : ''}
            </span>
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
            >
              Settings {showSettings ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="grid gap-x-6 gap-y-2 rounded-xl border border-border p-3 sm:grid-cols-2">
            <div>
              <div className="grid grid-cols-2 gap-x-3">
                <NumberField
                  label={batchMode ? 'Sample per batch' : 'Sample size'}
                  min={10}
                  max={500}
                  value={sampleSize}
                  onChange={(e) => setSampleSize(e.target.value)}
                  hint="10 to 500"
                />
                <NumberField label="Max results" min={1} max={50} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} hint="1 to 50" />
              </div>
              <Toggle
                checked={batchMode}
                onChange={setBatchMode}
                label="Batch mode"
                description="Evaluate several samples in parallel, then rank the combined picks."
              />
              {batchMode && (
                <NumberField
                  label="Batches"
                  min={3}
                  max={7}
                  value={batchCount}
                  onChange={(e) => setBatchCount(e.target.value)}
                  hint={`3 to 7 · ${batches}× coverage`}
                />
              )}
              <span className="mb-1 mt-2 block text-xs font-medium text-text-muted">Sent to the model</span>
              {(Object.keys(CONTEXT_LABELS) as (keyof RecommenderContextFields)[]).map((key) => (
                <Toggle
                  key={key}
                  checked={contextFields[key]}
                  onChange={(v) => setContextFields((f) => ({ ...f, [key]: v }))}
                  label={CONTEXT_LABELS[key].label}
                  description={CONTEXT_LABELS[key].description}
                />
              ))}
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-text-muted">Has chats</span>
              <SegmentedControl options={TRI_OPTIONS} value={hasChats} onChange={setHasChats} size="sm" className="mb-3" />
              <span className="mb-1 block text-xs font-medium text-text-muted">Favorite</span>
              <SegmentedControl options={TRI_OPTIONS} value={favorite} onChange={setFavorite} size="sm" className="mb-3" />
              <TagFilterInput label="Include tags (all of)" tags={includeTags} onChange={setIncludeTags} suggestions={allTags} />
              <TagFilterInput label="Exclude tags (any of)" tags={excludeTags} onChange={setExcludeTags} suggestions={allTags} />
              <div className="grid grid-cols-2 gap-x-3">
                <TextField label="Created from" type="date" value={createdFrom} onChange={(e) => setCreatedFrom(e.target.value)} />
                <TextField label="Created to" type="date" value={createdTo} onChange={(e) => setCreatedTo(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {busy && (
          <p className="flex items-center gap-2 text-xs text-text-muted">
            <Spinner /> {status || 'Working…'}
          </p>
        )}
        {error && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}
        {warning && <p className="rounded-lg bg-accent/10 p-2 text-xs text-text">{warning}</p>}

        {results.length > 0 && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-text-muted">
                {results.length} picks from {evaluated.toLocaleString()} characters evaluated
              </span>
              <span className="ml-auto flex flex-wrap items-center gap-2">
                <select
                  value={playlistTarget}
                  onChange={(e) => setPlaylistTarget(e.target.value)}
                  className="rounded-lg bg-bg-sunken px-2 py-1.5 text-xs text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
                  aria-label="Playlist"
                >
                  <option value={NEW_PLAYLIST}>New playlist…</option>
                  {playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {playlistTarget === NEW_PLAYLIST && (
                  <input
                    value={playlistName}
                    onChange={(e) => setPlaylistName(e.target.value)}
                    placeholder={lastRun?.prompt.slice(0, 60) || 'Playlist name'}
                    className="w-40 rounded-lg bg-bg-sunken px-2 py-1.5 text-xs text-text outline-none ring-1 ring-transparent placeholder:text-text-muted/55 focus:ring-accent/40"
                  />
                )}
                <Button onClick={saveToPlaylist} disabled={savingPlaylist || !resultIds.length}>
                  <span className="inline-flex items-center gap-1.5">
                    <ListPlus size={14} /> Add all to playlist
                  </span>
                </Button>
              </span>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {results.map((r, i) => {
                const c = byId.get(r.characterId)
                if (!c) return null
                const name = displayNameOf(c.card)
                const open = expanded.has(r.characterId)
                return (
                  <li key={r.characterId} className="flex gap-3 rounded-xl border border-border bg-bg p-2.5">
                    <button type="button" onClick={() => onOpen(c.id)} className="shrink-0" title={`Open ${name}`}>
                      {c.avatarDataUrl ? (
                        <img src={c.avatarDataUrl} alt="" className="h-16 w-12 rounded-lg object-cover" loading="lazy" />
                      ) : (
                        <span className="flex h-16 w-12 items-center justify-center rounded-lg bg-bg-sunken text-lg text-text-muted">
                          {name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onOpen(c.id)}
                        className="block max-w-full truncate text-left text-sm font-medium text-text hover:text-accent"
                      >
                        <span className="mr-1.5 text-xs text-text-muted">{i + 1}.</span>
                        {name}
                      </button>
                      {r.reason && (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(r.characterId)}
                          className={`mt-0.5 block w-full text-left text-xs text-text-muted hover:text-text ${open ? '' : 'line-clamp-2'}`}
                          aria-expanded={open}
                          title={open ? 'Collapse' : 'Show the full reason'}
                        >
                          {r.reason}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            {lastRun && !busy && (
              <p className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <RefreshCw size={11} /> Reroll skips the {shownIds.size} characters already suggested.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Tag pills plus a text input with library-tag autocomplete; Enter or comma adds. */
function TagFilterInput({
  label,
  tags,
  onChange,
  suggestions,
}: {
  label: string
  tags: string[]
  onChange: (tags: string[]) => void
  suggestions: string[]
}) {
  const [draft, setDraft] = useState('')
  const listId = useId()
  const add = (raw: string) => {
    const tag = raw.trim().toLowerCase()
    if (tag && !tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
  }
  return (
    <div className="mb-3">
      <span className="mb-1 block text-xs font-medium text-text-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-bg-sunken px-2 py-1.5">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-lg bg-accent/10 px-2 py-0.5 text-xs text-accent">
            {t}
            <button type="button" onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          list={listId}
          onChange={(e) => {
            const v = e.target.value
            // Picking a datalist option fires a change with the full tag; commit it straight away.
            if (suggestions.includes(v.trim().toLowerCase()) && v.length - draft.length > 1) add(v)
            else if (v.endsWith(',')) add(v.slice(0, -1))
            else setDraft(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(draft)
            } else if (e.key === 'Backspace' && !draft && tags.length) {
              onChange(tags.slice(0, -1))
            }
          }}
          placeholder={tags.length ? '' : 'Type a tag…'}
          className="min-w-24 flex-1 bg-transparent py-0.5 text-sm text-text outline-none placeholder:text-text-muted/55"
        />
        <datalist id={listId}>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      </div>
    </div>
  )
}
