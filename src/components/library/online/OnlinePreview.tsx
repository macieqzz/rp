import { useEffect, useState } from 'react'
import { Download, ExternalLink, Heart, Hash } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import type { Character } from '@/lib/characters/cardSpec'
import { onlineApi } from '@/lib/library/api'
import { PROVIDER_LABELS } from '@/lib/library/links'
import { importOnlineCharacter } from '@/lib/library/onlineImport'
import type { OnlineCharacterDetail, OnlineCharacterSummary } from '@/lib/library/types'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'

/** Plain-text card section. Card text is untrusted; it's shown verbatim, never as HTML. */
function TextSection({ title, text }: { title: string; text?: string }) {
  if (!text?.trim()) return null
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      <div className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-bg-sunken p-3 text-sm leading-relaxed text-text">{text}</div>
    </section>
  )
}

export function formatCount(n: number | undefined): string | undefined {
  if (n === undefined) return undefined
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

/** Full preview of one online character, fetched on open, with the import action. */
export function OnlinePreview({
  summary,
  local,
  onClose,
  onOpenLocal,
}: {
  summary: OnlineCharacterSummary
  /** The library character already linked to this result, if any. */
  local?: Character
  onClose: () => void
  onOpenLocal: (id: string) => void
}) {
  const [detail, setDetail] = useState<OnlineCharacterDetail>()
  const [error, setError] = useState<string>()
  const [withGallery, setWithGallery] = useState(true)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    onlineApi
      .character(summary.provider, summary.id)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [summary.provider, summary.id])

  const doImport = async () => {
    if (!detail) return
    setImporting(true)
    try {
      const created = await importOnlineCharacter(detail, { downloadGallery: withGallery })
      toastSuccess(`Imported "${created.card.name}".`)
      onClose()
    } catch (e) {
      toastError(errorMessage(e))
    } finally {
      setImporting(false)
    }
  }

  const view = detail ?? summary
  const card = detail?.card
  const portrait = detail?.imageUrl ?? summary.avatarUrl
  const gallery = detail?.gallery ?? []
  const stats = [
    formatCount(view.downloads) && { icon: Download, label: `${formatCount(view.downloads)} downloads` },
    formatCount(view.likes) && { icon: Heart, label: `${formatCount(view.likes)} likes` },
    formatCount(view.tokens) && { icon: Hash, label: `${formatCount(view.tokens)} tokens` },
  ].filter((s): s is { icon: typeof Download; label: string } => !!s)

  return (
    <Modal
      title={view.name}
      size="3xl"
      scrollable
      onClose={onClose}
      headerExtra={
        view.url && (
          <a href={view.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 text-xs text-text-muted hover:text-text">
            {PROVIDER_LABELS[view.provider]} <ExternalLink size={12} />
          </a>
        )
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="flex flex-col gap-5 sm:flex-row">
          <div className="w-full shrink-0 sm:w-56">
            <div className="portrait-frame aspect-[3/4] w-full overflow-hidden rounded-xl bg-bg-sunken">
              {portrait && <img src={portrait} alt="" className="h-full w-full object-cover" />}
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <div className="text-sm text-text-muted">by {view.creator || 'unknown creator'}</div>
              {view.tagline && <p className="mt-1 text-sm text-text">{view.tagline}</p>}
            </div>
            {stats.length > 0 && (
              <div className="flex flex-wrap gap-3 text-xs text-text-muted">
                {stats.map(({ icon: Icon, label }) => (
                  <span key={label} className="flex items-center gap-1">
                    <Icon size={12} /> {label}
                  </span>
                ))}
                {view.nsfw && <span className="rounded bg-danger/15 px-1.5 text-danger">NSFW</span>}
              </div>
            )}
            {view.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {view.tags.map((t) => (
                  <span key={t} className="rounded-md bg-bg-sunken px-2 py-0.5 text-xs text-text-muted">
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {local && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onClose()
                    onOpenLocal(local.id)
                  }}
                >
                  Open in library
                </Button>
              )}
              <Button variant={local ? 'secondary' : 'primary'} disabled={!detail || importing} onClick={() => void doImport()}>
                {importing ? 'Importing…' : local ? 'Import another copy' : 'Import'}
              </Button>
              {gallery.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-text-muted">
                  <input type="checkbox" checked={withGallery} onChange={(e) => setWithGallery(e.target.checked)} className="accent-[rgb(var(--c-accent))]" />
                  Also download provider gallery ({gallery.length})
                </label>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {error && <p className="text-sm text-danger">Couldn't load the full character: {error}</p>}
          {!detail && !error && (
            <p className="flex items-center gap-2 text-sm text-text-muted">
              <Spinner /> Loading character…
            </p>
          )}
          {card && (
            <>
              <TextSection title="Description" text={card.description} />
              <TextSection title="First message" text={card.first_mes} />
              {!!card.alternate_greetings?.length && (
                <p className="text-xs text-text-muted">+ {card.alternate_greetings.length} alternate greetings</p>
              )}
              <TextSection title="Scenario" text={card.scenario} />
              <TextSection title="Personality" text={card.personality} />
              <TextSection title="Creator notes" text={card.creator_notes} />
              {!!card.character_book?.entries.length && (
                <p className="text-xs text-text-muted">Embedded lorebook: {card.character_book.entries.length} entries</p>
              )}
            </>
          )}
          {gallery.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Gallery</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {gallery.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer noopener" className="aspect-square overflow-hidden rounded-lg bg-bg-sunken">
                    <img
                      src={onlineApi.imageUrl(url)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.visibility = 'hidden'
                      }}
                    />
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </Modal>
  )
}
