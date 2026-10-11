import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { CardDiffView } from '@/components/library/CardDiffView'
import { charactersApi } from '@/lib/api/client'
import type { Character, CharacterCardData } from '@/lib/characters/cardSpec'
import { libraryApi, onlineApi } from '@/lib/library/api'
import { diffCards } from '@/lib/library/diff'
import { getProviderLink } from '@/lib/library/links'
import { remoteCardForLocal } from '@/lib/library/onlineImport'
import type { ProviderLink, RemoteVersion } from '@/lib/library/types'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'

function ChubVersions({ character, link }: { character: Character; link: ProviderLink }) {
  const [versions, setVersions] = useState<RemoteVersion[]>()
  const [listError, setListError] = useState<string>()
  const [selected, setSelected] = useState<RemoteVersion>()
  const [remote, setRemote] = useState<CharacterCardData>()
  const [versionError, setVersionError] = useState<string>()
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    let cancelled = false
    setVersions(undefined)
    setListError(undefined)
    setSelected(undefined)
    onlineApi
      .versions(link.provider, link.id)
      .then((v) => !cancelled && setVersions(v))
      .catch((e) => !cancelled && setListError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [link.provider, link.id])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setRemote(undefined)
    setVersionError(undefined)
    onlineApi
      .version(link.provider, link.id, selected.id)
      .then((d) => !cancelled && setRemote(d.card))
      .catch((e) => !cancelled && setVersionError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [link.provider, link.id, selected])

  // Local extensions (link, favorite, library-only settings) are kept, so they never diff or revert.
  const incoming = remote && remoteCardForLocal(character.card, remote)
  const diffs = incoming ? diffCards(character.card, incoming) : []

  const restore = async () => {
    if (!incoming || !selected) return
    const ok = await confirmDialog({
      title: 'Restore this remote version?',
      body: 'The card text is replaced with this version from Chub. A snapshot of the current card is saved first.',
      confirmLabel: 'Restore',
      tone: 'default',
    })
    if (!ok) return
    setRestoring(true)
    try {
      await libraryApi.takeSnapshot(character.id, { auto: true, reason: 'Before remote version restore' })
      await charactersApi.update(character.id, { card: incoming })
      toastSuccess('Restored the remote version.')
    } catch (e) {
      toastError(errorMessage(e))
    } finally {
      setRestoring(false)
    }
  }

  if (listError) return <p className="text-sm text-danger">{listError}</p>
  if (!versions)
    return (
      <p className="flex items-center gap-2 text-sm text-text-muted">
        <Spinner /> Loading Chub history…
      </p>
    )
  if (versions.length === 0) return <p className="text-sm text-text-muted">Chub has no published versions for this character.</p>

  return (
    <div className="space-y-3">
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {versions.map((v, i) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => setSelected(v)}
              className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                selected?.id === v.id ? 'bg-accent/10 text-accent' : 'text-text hover:bg-bg-sunken'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{v.message || '(no message)'}</span>
              {i === 0 && <span className="shrink-0 text-[10px] uppercase text-text-muted">latest</span>}
              <span className="shrink-0 text-xs text-text-muted">{v.createdAt ? new Date(v.createdAt).toLocaleString() : ''}</span>
              <span className="shrink-0 font-mono text-[10px] text-text-muted">{v.id.slice(0, 7)}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="space-y-2 border-t border-border pt-3">
          {versionError && <p className="text-sm text-danger">{versionError}</p>}
          {!remote && !versionError && (
            <p className="flex items-center gap-2 text-sm text-text-muted">
              <Spinner /> Loading version…
            </p>
          )}
          {incoming && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-text-muted">Changes this version would make to the current card</span>
                <Button variant="primary" disabled={restoring || diffs.length === 0} onClick={() => void restore()}>
                  {restoring ? 'Restoring…' : 'Restore this version'}
                </Button>
              </div>
              <CardDiffView diffs={diffs} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Remote (provider-side) version history for a linked character — Chub's git log of the card. */
export function RemoteVersionsSection({ character }: { character: Character }) {
  const link = getProviderLink(character.card)
  if (!link || link.provider !== 'chub') {
    return <p className="text-sm text-text-muted">Remote version history is available for characters linked to Chub.</p>
  }
  return <ChubVersions character={character} link={link} />
}
