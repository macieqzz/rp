import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Download, ImagePlus, Link2, Music, Play, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { MediaViewer } from '@/components/library/gallery/MediaViewer'
import { charactersApi } from '@/lib/api/client'
import type { Character, GalleryEntry } from '@/lib/characters/cardSpec'
import { fileToDataUrl } from '@/lib/characters/importExport'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import { libraryApi } from '@/lib/library/api'
import { classifyMediaUrl, extractEmbeddedMedia } from '@/lib/library/embeddedMedia'
import type { ExtractResult, MediaFetchResult, MediaItem, MediaKind } from '@/lib/library/types'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastInfo, toastSuccess } from '@/lib/store/useToastStore'

type Filter = 'all' | MediaKind

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
]

/** Outcome of one download run (embedded media or a pasted link), shown until dismissed. */
interface RunLog {
  downloaded: number
  skipped: number
  failed: number
  /** Albums that resolved, with how many files each turned up. */
  albums: { url: string; host: string; found: number }[]
  errors: { url: string; error: string }[]
}

function summarize(fetched: MediaFetchResult[], extracted: ExtractResult[], requestErrors: { url: string; error: string }[]): RunLog {
  const log: RunLog = { downloaded: 0, skipped: 0, failed: requestErrors.length, albums: [], errors: [...requestErrors] }
  const count = (r: MediaFetchResult) => {
    if (!r.ok) {
      log.failed++
      log.errors.push({ url: r.url, error: r.error ?? 'Download failed.' })
    } else if (r.skipped) log.skipped++
    else log.downloaded++
  }
  fetched.forEach(count)
  for (const album of extracted) {
    if (album.found > 0) log.albums.push({ url: album.url, host: album.host, found: album.found })
    album.downloaded.forEach(count)
    // An album that never resolved has no per-file results to count — report the album itself.
    if (album.downloaded.length === 0 && !album.ok) {
      log.failed++
      log.errors.push({ url: album.url, error: `${album.host}: ${album.error ?? 'Extraction failed.'}` })
    }
  }
  return log
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The details modal's Gallery tab: the character's library media folder (uploads, card-embedded
 * links and album downloads) as a filterable grid with a full-screen viewer, plus a read-only view
 * of the character's CG gallery so all of its art is in one place.
 */
export function GalleryTab({ character }: { character: Character }) {
  const media = useApiQuery('library-media', () => libraryApi.media(character.id), [character.id])
  const [filter, setFilter] = useState<Filter>('all')
  const [viewer, setViewer] = useState<{ items: MediaItem[]; index: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<RunLog | null>(null)
  const [link, setLink] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const embedded = useMemo(() => extractEmbeddedMedia(character.card), [character.card])
  const embeddedCount = embedded.direct.length + embedded.albums.length

  const items = media ?? []
  const counts: Record<Filter, number> = {
    all: items.length,
    image: items.filter((m) => m.kind === 'image').length,
    video: items.filter((m) => m.kind === 'video').length,
    audio: items.filter((m) => m.kind === 'audio').length,
  }
  const visible = items.filter((m) => filter === 'all' || m.kind === filter)
  const visual = visible.filter((m) => m.kind !== 'audio')
  const audio = visible.filter((m) => m.kind === 'audio')
  // Viewer order follows display order: the grid first, then the audio list.
  const ordered = [...visual, ...audio]

  const cgImages = (character.gallery ?? [])
    .filter((g) => g.imageUrl)
    .map((g): MediaItem => ({ name: g.title || g.id, url: g.imageUrl, kind: 'image', size: 0, modifiedAt: 0 }))

  /** Downloads direct URLs and extracts album URLs, then shows the combined result log. */
  async function runDownload(direct: string[], albums: string[]) {
    setLog(null)
    const fetched: MediaFetchResult[] = []
    const extracted: ExtractResult[] = []
    const requestErrors: { url: string; error: string }[] = []
    try {
      if (direct.length > 0) {
        setBusy(`Downloading ${direct.length} file${direct.length === 1 ? '' : 's'}…`)
        try {
          fetched.push(...(await libraryApi.fetchMedia(character.id, direct)))
        } catch (e) {
          requestErrors.push(...direct.map((url) => ({ url, error: errorMessage(e) })))
        }
      }
      if (albums.length > 0) {
        setBusy(`Extracting ${albums.length} album${albums.length === 1 ? '' : 's'}…`)
        const context = [character.card.creator_notes, character.card.description].filter(Boolean).join('\n\n')
        try {
          extracted.push(...(await libraryApi.extractMedia(character.id, albums, context)))
        } catch (e) {
          requestErrors.push(...albums.map((url) => ({ url, error: errorMessage(e) })))
        }
      }
    } finally {
      setBusy(null)
    }
    const result = summarize(fetched, extracted, requestErrors)
    setLog(result)
    if (result.downloaded > 0) toastSuccess(`Downloaded ${result.downloaded} file${result.downloaded === 1 ? '' : 's'}.`)
    else if (result.failed > 0) toastError('Nothing could be downloaded — see the log for details.')
    else toastInfo('Everything was already downloaded.')
  }

  async function downloadEmbedded() {
    if (embeddedCount === 0) {
      toastInfo('This card has no media links.')
      return
    }
    await runDownload(embedded.direct, embedded.albums)
  }

  async function downloadLink(e: FormEvent) {
    e.preventDefault()
    const url = link.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) {
      toastError('Paste a full http(s) link.')
      return
    }
    // Unknown pages still go to the direct downloader, which reports "not a media file" clearly.
    const isAlbum = classifyMediaUrl(url) === 'album'
    await runDownload(isAlbum ? [] : [url], isAlbum ? [url] : [])
    setLink('')
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    const list = Array.from(files)
    let uploaded = 0
    try {
      for (const [i, file] of list.entries()) {
        setBusy(`Uploading ${i + 1} / ${list.length}…`)
        try {
          await libraryApi.uploadMedia(character.id, file.name, await fileToDataUrl(file))
          uploaded++
        } catch (e) {
          toastError(`${file.name}: ${errorMessage(e)}`)
        }
      }
    } finally {
      setBusy(null)
      if (fileInput.current) fileInput.current.value = ''
    }
    if (uploaded > 0) toastSuccess(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}.`)
  }

  async function remove(item: MediaItem) {
    const ok = await confirmDialog({
      title: `Delete ${item.name}?`,
      body: "The file is removed from this character's media folder.",
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await libraryApi.deleteMedia(character.id, item.name)
    } catch (e) {
      toastError(errorMessage(e))
    }
  }

  async function addToCg(item: MediaItem) {
    setBusy('Adding to the CG gallery…')
    try {
      const res = await fetch(item.url)
      if (!res.ok) throw new Error(`Could not read ${item.name} (HTTP ${res.status}).`)
      const entry: GalleryEntry = {
        id: `cg-${Date.now()}`,
        title: item.name.replace(/\.[^.]+$/, ''),
        imageUrl: await fileToDataUrl(await res.blob()),
        unlockAffection: 0,
      }
      await charactersApi.update(character.id, { gallery: [...(character.gallery ?? []), entry] })
      toastSuccess(`Added ${entry.title} to the CG gallery.`)
    } catch (e) {
      toastError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const disabled = busy !== null

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} {counts[f.id]}
            </Chip>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              accept="image/*,video/*,audio/*"
              className="hidden"
              onChange={(e) => void upload(e.target.files)}
            />
            <Button onClick={() => fileInput.current?.click()} disabled={disabled} className="inline-flex items-center gap-1.5">
              <Upload size={14} /> Upload
            </Button>
            <Button
              onClick={() => void downloadEmbedded()}
              disabled={disabled || embeddedCount === 0}
              title={
                embeddedCount === 0
                  ? 'This card has no media links'
                  : `${embedded.direct.length} direct file${embedded.direct.length === 1 ? '' : 's'}, ${embedded.albums.length} album${embedded.albums.length === 1 ? '' : 's'}`
              }
              className="inline-flex items-center gap-1.5"
            >
              <Download size={14} /> Download embedded media{embeddedCount > 0 ? ` (${embeddedCount})` : ''}
            </Button>
          </div>
        </div>

        <form onSubmit={(e) => void downloadLink(e)} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Link2 size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="Download from link… (album, share page or direct file URL)"
              aria-label="Download from link"
              className="w-full rounded-xl bg-bg-sunken py-2 pl-8 pr-3 text-sm text-text outline-none ring-1 ring-transparent transition-shadow placeholder:text-text-muted/55 focus:ring-accent/40"
            />
          </div>
          <Button type="submit" disabled={disabled || !link.trim()}>
            Download
          </Button>
        </form>

        {busy && (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Spinner /> {busy}
          </div>
        )}

        {log && (
          <div className="rounded-xl border border-border bg-bg-sunken p-3 text-xs">
            <div className="flex items-center gap-3">
              <span className="text-text">
                <strong>{log.downloaded}</strong> downloaded
              </span>
              <span className="text-text-muted">
                <strong>{log.skipped}</strong> already saved
              </span>
              <span className={log.failed > 0 ? 'text-danger' : 'text-text-muted'}>
                <strong>{log.failed}</strong> failed
              </span>
              <IconButton icon={X} title="Dismiss" size={14} boxSize={24} onClick={() => setLog(null)} className="ml-auto" />
            </div>
            {log.albums.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-text-muted">
                {log.albums.map((a) => (
                  <li key={a.url} className="truncate" title={a.url}>
                    {a.host}: {a.found} file{a.found === 1 ? '' : 's'} found — {a.url}
                  </li>
                ))}
              </ul>
            )}
            {log.errors.length > 0 && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {log.errors.map((err, i) => (
                  <li key={`${err.url}-${i}`} className="break-all">
                    <span className="text-danger">{err.error}</span> <span className="text-text-muted">{err.url}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {media === undefined ? (
          <div className="flex justify-center py-10 text-text-muted">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            action={
              filter === 'all' ? (
                <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={disabled}>
                  Upload files
                </Button>
              ) : undefined
            }
          >
            {filter === 'all'
              ? 'No media yet. Upload files, download the media this card links to, or paste an album link above.'
              : `No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} in this character's media.`}
          </EmptyState>
        ) : (
          <>
            {visual.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                {visual.map((item, i) => (
                  <div key={item.name} className="group relative aspect-square overflow-hidden rounded-xl bg-bg-sunken">
                    {item.kind === 'image' ? (
                      <img src={item.url} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <>
                        <video src={item.url} preload="metadata" muted playsInline className="h-full w-full object-cover" />
                        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                          <span className="rounded-full bg-black/50 p-2 text-white">
                            <Play size={16} />
                          </span>
                        </span>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setViewer({ items: ordered, index: i })}
                      title={`${item.name} · ${formatBytes(item.size)}`}
                      aria-label={`Open ${item.name}`}
                      className="absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    />
                    <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      {item.kind === 'image' && (
                        <IconButton icon={ImagePlus} title="Add to CG gallery" tone="glass" size={14} boxSize={28} disabled={disabled} onClick={() => void addToCg(item)} className="bg-black/50" />
                      )}
                      <IconButton icon={Trash2} title="Delete" tone="glass" size={14} boxSize={28} onClick={() => void remove(item)} className="bg-black/50" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {audio.length > 0 && (
              <ul className="space-y-2">
                {audio.map((item, i) => (
                  <li key={item.name} className="flex flex-wrap items-center gap-3 rounded-xl bg-bg-sunken px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setViewer({ items: ordered, index: visual.length + i })}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-text hover:text-accent"
                    >
                      <Music size={16} className="shrink-0 text-text-muted" />
                      <span className="truncate">{item.name}</span>
                      <span className="shrink-0 text-[11px] text-text-muted">{formatBytes(item.size)}</span>
                    </button>
                    <audio src={item.url} controls preload="none" className="h-8 w-full sm:w-64" />
                    <IconButton icon={Trash2} title="Delete" size={15} boxSize={30} onClick={() => void remove(item)} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">CG gallery</h3>
        {cgImages.length === 0 ? (
          <p className="text-xs text-text-muted">No CG gallery images yet — use “Add to CG gallery” on an image above.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {cgImages.map((cg, i) => (
              <button
                key={`${cg.url}-${i}`}
                type="button"
                onClick={() => setViewer({ items: cgImages, index: i })}
                title={cg.name}
                className="group relative aspect-square overflow-hidden rounded-xl bg-bg-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <img src={cg.url} alt={cg.name} loading="lazy" className="h-full w-full object-cover" />
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-left text-[11px] text-white">{cg.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {viewer && (
        <MediaViewer
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onIndexChange={(index) => setViewer((v) => (v ? { ...v, index } : v))}
        />
      )}
    </div>
  )
}
