import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import type { Character } from '@/lib/characters/cardSpec'
import { libraryApi } from '@/lib/library/api'
import { displayNameOf } from '@/lib/library/links'
import type { Playlist } from '@/lib/library/types'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { PLAYLIST_COLORS, PLAYLIST_ICONS } from './playlistIcons'

export function PlaylistIcon({ playlist, size = 14 }: { playlist: Pick<Playlist, 'icon' | 'color'>; size?: number }) {
  const Icon = PLAYLIST_ICONS[playlist.icon] ?? PLAYLIST_ICONS['list-music']
  return <Icon size={size} style={{ color: playlist.color }} className="shrink-0" />
}

/** Create or edit a playlist: name, icon, colour, and its members in order. */
export function PlaylistDialog({
  playlist,
  characters,
  initialMembers = [],
  onClose,
  onSaved,
}: {
  playlist?: Playlist
  characters: Character[]
  /** For "new playlist from selection". */
  initialMembers?: string[]
  onClose: () => void
  onSaved?: (playlist: Playlist) => void
}) {
  const [name, setName] = useState(playlist?.name ?? '')
  const [icon, setIcon] = useState(playlist?.icon ?? 'list-music')
  const [color, setColor] = useState(playlist?.color ?? PLAYLIST_COLORS[0])
  const [members, setMembers] = useState<string[]>(playlist?.characterIds ?? initialMembers)
  const [busy, setBusy] = useState(false)
  const byId = new Map(characters.map((c) => [c.id, c]))

  const move = (i: number, delta: number) =>
    setMembers((m) => {
      const j = i + delta
      if (j < 0 || j >= m.length) return m
      const next = [...m]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const save = async () => {
    setBusy(true)
    try {
      const input = { name: name.trim() || 'New playlist', icon, color, characterIds: members }
      const saved = playlist ? await libraryApi.updatePlaylist(playlist.id, input) : await libraryApi.createPlaylist(input)
      onSaved?.(saved)
      onClose()
    } catch (e) {
      toastError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!playlist) return
    if (!(await confirmDialog({ title: `Delete playlist "${playlist.name}"?`, body: 'Only the playlist goes; its characters stay in your library.', confirmLabel: 'Delete', tone: 'danger' }))) return
    await libraryApi.deletePlaylist(playlist.id)
    onClose()
  }

  return (
    <Modal title={playlist ? 'Edit playlist' : 'New playlist'} size="lg" scrollable onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-bg-sunken">
          <PlaylistIcon playlist={{ icon, color }} size={18} />
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Playlist name"
          className="flex-1 rounded-xl bg-bg-sunken px-3 py-2 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
        />
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {Object.entries(PLAYLIST_ICONS).map(([key, Icon]) => (
          <button
            key={key}
            type="button"
            title={key}
            onClick={() => setIcon(key)}
            className={`rounded-lg p-1.5 ${icon === key ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-bg-sunken'}`}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {PLAYLIST_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Colour ${c}`}
            onClick={() => setColor(c)}
            style={{ background: c }}
            className={`h-6 w-6 rounded-full ${color === c ? 'ring-2 ring-text ring-offset-2 ring-offset-bg-elevated' : ''}`}
          />
        ))}
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom colour" className="h-6 w-8 cursor-pointer bg-transparent" />
      </div>
      <div className="mb-1 text-xs font-medium text-text-muted">
        {members.length} character{members.length === 1 ? '' : 's'}, in order
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {members.map((id, i) => {
          const c = byId.get(id)
          if (!c) return null
          return (
            <div key={id} className="flex items-center gap-2 rounded-lg bg-bg-sunken px-2 py-1">
              <span className="w-6 text-right text-xs text-text-muted">{i + 1}</span>
              {c.avatarDataUrl && <img src={c.avatarDataUrl} alt="" className="h-7 w-6 rounded object-cover" />}
              <span className="flex-1 truncate text-sm text-text">{displayNameOf(c.card)}</span>
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-text-muted hover:text-text disabled:opacity-30">
                <ArrowUp size={13} />
              </button>
              <button type="button" aria-label="Move down" disabled={i === members.length - 1} onClick={() => move(i, 1)} className="p-1 text-text-muted hover:text-text disabled:opacity-30">
                <ArrowDown size={13} />
              </button>
              <button type="button" aria-label="Remove" onClick={() => setMembers((m) => m.filter((x) => x !== id))} className="p-1 text-text-muted hover:text-danger">
                <X size={13} />
              </button>
            </div>
          )
        })}
        {members.length === 0 && <p className="text-xs text-text-muted">Add characters from the grid (select them, then “Add to playlist”, or right-click a card).</p>}
      </div>
      <div className="mt-4 flex items-center gap-2">
        {playlist && (
          <Button variant="ghost" onClick={remove} className="text-danger">
            Delete playlist
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Adds characters to an existing playlist, or to a new one created on the spot. */
export function AddToPlaylistDialog({
  characterIds,
  playlists,
  onClose,
}: {
  characterIds: string[]
  playlists: Playlist[]
  onClose: () => void
}) {
  const [newName, setNewName] = useState('')
  const add = async (target: Playlist | null) => {
    try {
      if (target) await libraryApi.playlistMembers(target.id, { add: characterIds })
      else await libraryApi.createPlaylist({ name: newName.trim() || 'New playlist', characterIds })
      toastSuccess(`Added ${characterIds.length} to ${target ? target.name : newName.trim() || 'New playlist'}.`)
      onClose()
    } catch (e) {
      toastError(errorMessage(e))
    }
  }
  return (
    <Modal title={`Add ${characterIds.length} to a playlist`} size="md" scrollable onClose={onClose}>
      <div className="min-h-0 space-y-1 overflow-y-auto">
        {playlists.map((p) => {
          const already = characterIds.every((id) => p.characterIds.includes(id))
          return (
            <button
              key={p.id}
              type="button"
              disabled={already}
              onClick={() => add(p)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text hover:bg-bg-sunken disabled:opacity-40"
            >
              <PlaylistIcon playlist={p} />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="text-xs text-text-muted">{already ? 'already in' : p.characterIds.length}</span>
            </button>
          )
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add(null)}
          placeholder="New playlist name"
          className="flex-1 rounded-xl bg-bg-sunken px-3 py-1.5 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
        />
        <Button variant="primary" onClick={() => add(null)} className="flex items-center gap-1">
          <Plus size={14} /> Create
        </Button>
      </div>
    </Modal>
  )
}
