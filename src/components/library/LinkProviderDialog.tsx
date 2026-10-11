import { useState, type FormEvent } from 'react'
import { ExternalLink, Search } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import type { Character } from '@/lib/characters/cardSpec'
import { libraryApi, onlineApi } from '@/lib/library/api'
import { PROVIDER_LABELS, getProviderLink } from '@/lib/library/links'
import { providerLinkOf } from '@/lib/library/onlineImport'
import type { OnlineCharacterSummary, ProviderId } from '@/lib/library/types'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'

const PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderId[]

function Candidate({ item, busy, onLink }: { item: OnlineCharacterSummary; busy: boolean; onLink: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-bg-sunken p-2">
      <div className="h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-bg">
        {item.avatarUrl && <img src={item.avatarUrl} alt="" loading="lazy" className="h-full w-full object-cover" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text">{item.name}</div>
        <div className="truncate text-xs text-text-muted">
          {PROVIDER_LABELS[item.provider]} · {item.creator || 'unknown creator'}
          {item.tokens !== undefined && ` · ${item.tokens.toLocaleString()} tokens`}
        </div>
        {item.tagline && <div className="truncate text-xs text-text-muted">{item.tagline}</div>}
      </div>
      {item.url && (
        <a href={item.url} target="_blank" rel="noreferrer noopener" title="Open on the provider's site" className="shrink-0 p-1 text-text-muted hover:text-text">
          <ExternalLink size={14} />
        </a>
      )}
      <Button variant="primary" disabled={busy} onClick={onLink}>
        Link
      </Button>
    </div>
  )
}

/**
 * Links a library character to its online source (for update checks and remote versions): by
 * pasting the character's URL, or by searching a provider for the character's name and creator.
 */
export function LinkProviderDialog({ character, onClose }: { character: Character; onClose: () => void }) {
  const current = getProviderLink(character.card)
  const [url, setUrl] = useState('')
  const [resolved, setResolved] = useState<OnlineCharacterSummary>()
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string>()
  const [provider, setProvider] = useState<ProviderId>(current?.provider ?? 'chub')
  const [matches, setMatches] = useState<OnlineCharacterSummary[]>()
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const setLink = async (target: OnlineCharacterSummary | null) => {
    setBusy(true)
    try {
      await libraryApi.batch([character.id], { action: 'setLink', value: target && providerLinkOf(target) })
      toastSuccess(target ? `Linked to ${PROVIDER_LABELS[target.provider]}: ${target.name}` : 'Link removed.')
      onClose()
    } catch (e) {
      toastError(errorMessage(e))
      setBusy(false)
    }
  }

  const lookUp = async (e: FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    setResolving(true)
    setResolved(undefined)
    setResolveError(undefined)
    try {
      const { provider: p, id } = await onlineApi.resolveUrl(url.trim())
      setResolved(await onlineApi.character(p, id))
    } catch (err) {
      setResolveError(errorMessage(err))
    } finally {
      setResolving(false)
    }
  }

  const findMatches = async () => {
    const name = character.card.name.trim()
    const creator = character.card.creator?.trim() ?? ''
    setSearching(true)
    setMatches(undefined)
    setSearchError(undefined)
    try {
      // Creator-narrowed first (most precise), then by name alone — imported cards often carry a
      // creator string that differs from the provider account name.
      const byCreator = creator ? await onlineApi.search(provider, { query: name, creator, nsfw: true, sort: 'popular' }) : undefined
      const result = byCreator?.items.length ? byCreator : await onlineApi.search(provider, { query: name, nsfw: true, sort: 'popular' })
      setMatches(result.items.slice(0, 20))
    } catch (err) {
      setSearchError(errorMessage(err))
    } finally {
      setSearching(false)
    }
  }

  return (
    <Modal
      title={`Link "${character.card.name}" to an online source`}
      description="A linked character can be checked for card updates and, on Chub, browsed through its remote version history."
      size="xl"
      scrollable
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        {current && (
          <section className="flex items-center gap-3 rounded-xl border border-border p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-text-muted">Currently linked to {PROVIDER_LABELS[current.provider]}</div>
              {current.url ? (
                <a href={current.url} target="_blank" rel="noreferrer noopener" className="block truncate text-accent hover:underline">
                  {current.id}
                </a>
              ) : (
                <div className="truncate text-text">{current.id}</div>
              )}
            </div>
            <Button variant="danger" disabled={busy} onClick={() => void setLink(null)}>
              Unlink
            </Button>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Paste a character link</h3>
          <form onSubmit={(e) => void lookUp(e)} className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://chub.ai/characters/creator/name"
              className="min-w-0 flex-1 rounded-xl bg-bg-sunken px-3 py-2 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
            />
            <Button type="submit" disabled={resolving || !url.trim()}>
              {resolving ? 'Looking up…' : 'Look up'}
            </Button>
          </form>
          {resolveError && <p className="text-sm text-danger">{resolveError}</p>}
          {resolved && <Candidate item={resolved} busy={busy} onLink={() => void setLink(resolved)} />}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Find matches</h3>
          <div className="flex gap-2">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderId)}
              aria-label="Provider"
              className="rounded-xl bg-bg-sunken px-3 py-2 text-sm text-text outline-none focus:ring-1 focus:ring-accent/40"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
            <Button disabled={searching} onClick={() => void findMatches()}>
              <span className="flex items-center gap-1.5">
                <Search size={14} /> Search for “{character.card.name}”
              </span>
            </Button>
          </div>
          {searching && (
            <p className="flex items-center gap-2 text-sm text-text-muted">
              <Spinner /> Searching {PROVIDER_LABELS[provider]}…
            </p>
          )}
          {searchError && <p className="text-sm text-danger">{searchError}</p>}
          {matches?.length === 0 && <p className="text-sm text-text-muted">No matches on {PROVIDER_LABELS[provider]}.</p>}
          {matches && matches.length > 0 && (
            <div className="space-y-2">
              {matches.map((m) => (
                <Candidate key={m.id} item={m} busy={busy} onLink={() => void setLink(m)} />
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  )
}
