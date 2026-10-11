import { useMemo, useState } from 'react'
import type { Character } from '@/lib/characters/cardSpec'
import { charactersApi } from '@/lib/api/client'
import { fileToDataUrl } from '@/lib/characters/importExport'
import { libraryApi } from '@/lib/library/api'
import { findDuplicates } from '@/lib/library/duplicates'
import { displayNameOf } from '@/lib/library/links'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Slider } from '@/components/ui/Slider'
import { Toggle } from '@/components/ui/Toggle'

/** Copies every library media file of `fromId` into `toId`'s folder (before `fromId` is deleted). */
async function transferMedia(fromId: string, toId: string): Promise<number> {
  let moved = 0
  for (const item of await libraryApi.media(fromId)) {
    const blob = await (await fetch(item.url)).blob()
    await libraryApi.uploadMedia(toId, item.name, await fileToDataUrl(blob))
    moved++
  }
  return moved
}

/**
 * Duplicate finder: fuzzy name + creator + content-overlap scoring with a sensitivity slider
 * (100 = exact mode: identical card text only). Delete extras with optional media transfer to the
 * kept card, or collect the newest/oldest of each exact group into a playlist for cleanup.
 */
export function DuplicatesDialog({ characters, onOpen, onClose }: { characters: Character[]; onOpen: (id: string) => void; onClose: () => void }) {
  const [sensitivity, setSensitivity] = useState(70)
  const [moveMedia, setMoveMedia] = useState(true)
  const groups = useMemo(() => findDuplicates(characters, sensitivity), [characters, sensitivity])
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters])

  const remove = async (id: string, keepId: string) => {
    const c = byId.get(id)
    if (!c) return
    if (!(await confirmDialog({ title: `Delete this copy of ${c.card.name}?`, body: 'Its chats and snapshots are deleted with it.', confirmLabel: 'Delete', tone: 'danger' }))) return
    try {
      const moved = moveMedia ? await transferMedia(id, keepId) : 0
      await charactersApi.remove(id)
      toastSuccess(`Deleted${moved ? `, ${moved} media file${moved === 1 ? '' : 's'} moved to the kept copy` : ''}.`)
    } catch (e) {
      toastError(errorMessage(e))
    }
  }

  const collect = async (which: 'newest' | 'oldest') => {
    const ids = groups.map((g) => (which === 'oldest' ? g.ids[0] : g.ids[g.ids.length - 1]))
    await libraryApi.createPlaylist({ name: `Duplicates (${which})`, icon: 'bookmark', characterIds: ids })
    toastSuccess(`Playlist "Duplicates (${which})" created with ${ids.length} characters.`)
  }

  return (
    <Modal title="Duplicate finder" size="3xl" scrollable onClose={onClose}>
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Slider
          label="Sensitivity"
          min={40}
          max={100}
          step={5}
          value={sensitivity}
          onChange={setSensitivity}
          formatValue={(v) => (v >= 100 ? 'exact' : String(v))}
          description="Lower finds more (looser) matches. At maximum only identical cards count."
        />
        <Toggle checked={moveMedia} onChange={setMoveMedia} label="Move media to the kept copy on delete" />
      </div>
      {sensitivity >= 100 && groups.length > 0 && (
        <div className="mb-3 flex gap-2">
          <Button onClick={() => collect('newest')}>Collect newest into a playlist</Button>
          <Button onClick={() => collect('oldest')}>Collect oldest into a playlist</Button>
        </div>
      )}
      <div className="min-h-0 space-y-3 overflow-y-auto">
        {groups.length === 0 && <p className="py-8 text-center text-sm text-text-muted">No duplicates at this sensitivity.</p>}
        {groups.map((g) => (
          <div key={g.ids.join()} className="rounded-xl border border-border bg-bg-elevated p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <span className="rounded bg-accent/15 px-1.5 text-accent">{g.confidence}%</span>
              {g.reasons.join(' · ')}
            </div>
            <div className="flex flex-wrap gap-2">
              {g.ids.map((id, i) => {
                const c = byId.get(id)
                if (!c) return null
                return (
                  <div key={id} className="flex w-56 gap-2 rounded-lg bg-bg-sunken p-2">
                    <button type="button" onClick={() => onOpen(id)} className="h-16 w-12 shrink-0 overflow-hidden rounded bg-bg">
                      {c.avatarDataUrl && <img src={c.avatarDataUrl} alt="" className="h-full w-full object-cover" />}
                    </button>
                    <div className="min-w-0 flex-1 text-xs">
                      <div className="truncate text-sm text-text">{displayNameOf(c.card)}</div>
                      <div className="truncate text-text-muted">{c.card.creator || 'no creator'}</div>
                      <div className="text-text-muted">{new Date(c.createdAt).toLocaleDateString()}{i === 0 ? ' · oldest' : ''}</div>
                      <button type="button" onClick={() => remove(id, g.ids.find((x) => x !== id)!)} className="mt-0.5 text-danger hover:underline">
                        Delete this copy
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
