import { useState } from 'react'
import { Camera, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import type { Character } from '@/lib/characters/cardSpec'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import { libraryApi } from '@/lib/library/api'
import { diffCards } from '@/lib/library/diff'
import { getProviderLink } from '@/lib/library/links'
import type { CharacterSnapshot } from '@/lib/library/types'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Section } from '@/components/ui/Section'
import { EmptyState } from '@/components/ui/EmptyState'
import { CardDiffView } from '../CardDiffView'
import { RemoteVersionsSection } from '../RemoteVersionsSection'

/** Local snapshots (manual and automatic) with diff/restore/rename/delete, plus Chub's remote history for linked cards. */
export function VersionsTab({ character }: { character: Character }) {
  const snapshots = useApiQuery(['library-snapshots', 'characters'], () => libraryApi.snapshots(character.id), [character.id]) ?? []
  const [label, setLabel] = useState('')
  const [viewing, setViewing] = useState<CharacterSnapshot | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null)
  const link = getProviderLink(character.card)

  const take = async () => {
    try {
      await libraryApi.takeSnapshot(character.id, { label: label.trim() || undefined })
      setLabel('')
      toastSuccess('Snapshot saved.')
    } catch (e) {
      toastError(errorMessage(e))
    }
  }

  const restore = async (snap: CharacterSnapshot) => {
    const withAvatar = !!snap.avatarUrl && snap.avatarUrl.split('?')[0] !== character.avatarDataUrl?.split('?')[0]
    const ok = await confirmDialog({
      title: `Restore "${snap.label}"?`,
      body: 'The current card is backed up as an automatic snapshot first, so you can undo this from here.',
      confirmLabel: 'Restore',
      tone: 'default',
    })
    if (!ok) return
    try {
      await libraryApi.restoreSnapshot(snap.id, { avatar: withAvatar })
      setViewing(null)
      toastSuccess('Restored. The previous state is the newest automatic snapshot.')
    } catch (e) {
      toastError(errorMessage(e))
    }
  }

  const remove = async (snap: CharacterSnapshot) => {
    if (!(await confirmDialog({ title: `Delete "${snap.label}"?`, confirmLabel: 'Delete', tone: 'danger' }))) return
    await libraryApi.deleteSnapshot(snap.id)
  }

  return (
    <div className="space-y-6">
      <Section title="Local snapshots" surface="bare" description="Automatic backups are taken before every edit, restore and card update (latest 10 kept); manual snapshots are never pruned.">
        <div className="mb-3 flex gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && take()}
            placeholder="Snapshot name (optional)"
            className="flex-1 rounded-xl bg-bg-sunken px-3 py-1.5 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
          />
          <Button variant="primary" onClick={take} className="flex items-center gap-1.5">
            <Camera size={14} /> Save snapshot
          </Button>
        </div>
        {snapshots.length === 0 && <EmptyState>No snapshots yet.</EmptyState>}
        <div className="space-y-1.5">
          {snapshots.map((s) => {
            const changes = diffCards(s.card, character.card).length
            return (
              <div key={s.id} className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-3 py-2">
                {s.avatarUrl && <img src={s.avatarUrl} alt="" className="h-10 w-8 shrink-0 rounded object-cover" />}
                <div className="min-w-0 flex-1">
                  {renaming?.id === s.id ? (
                    <input
                      autoFocus
                      value={renaming.label}
                      onChange={(e) => setRenaming({ id: s.id, label: e.target.value })}
                      onBlur={async () => {
                        if (renaming.label.trim() && renaming.label !== s.label) await libraryApi.renameSnapshot(s.id, renaming.label)
                        setRenaming(null)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      className="w-full rounded bg-bg-sunken px-2 py-0.5 text-sm text-text outline-none"
                    />
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-text">
                      <span className="truncate">{s.label}</span>
                      {s.auto && <span className="rounded bg-bg-sunken px-1.5 text-[10px] text-text-muted">auto</span>}
                    </div>
                  )}
                  <div className="text-xs text-text-muted">
                    {new Date(s.createdAt).toLocaleString()} · {changes ? `${changes} field${changes === 1 ? '' : 's'} differ from now` : 'same as now'}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => setViewing(s)} disabled={!changes}>
                  Diff
                </Button>
                <button type="button" title="Restore" onClick={() => restore(s)} className="rounded p-1.5 text-text-muted hover:text-accent">
                  <RotateCcw size={14} />
                </button>
                <button type="button" title="Rename" onClick={() => setRenaming({ id: s.id, label: s.label })} className="rounded p-1.5 text-text-muted hover:text-text">
                  <Pencil size={14} />
                </button>
                <button type="button" title="Delete" onClick={() => remove(s)} className="rounded p-1.5 text-text-muted hover:text-danger">
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      </Section>

      {link?.provider === 'chub' && (
        <Section title="Remote versions (Chub)" surface="bare">
          <RemoteVersionsSection character={character} />
        </Section>
      )}

      {viewing && (
        <Modal title={`"${viewing.label}" → current card`} description="Red is what the snapshot has, green is what the card has now." size="3xl" scrollable onClose={() => setViewing(null)}>
          <CardDiffView diffs={diffCards(viewing.card, character.card)} />
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setViewing(null)}>Close</Button>
            <Button variant="primary" onClick={() => restore(viewing)}>
              Restore this snapshot
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
