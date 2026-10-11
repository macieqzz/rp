import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import type { Character } from '@/lib/characters/cardSpec'
import { charactersApi } from '@/lib/api/client'
import { importCharacterFile } from '@/lib/characters/importExport'
import { importCharacterPack, parseCharacterPackFile } from '@/lib/characters/pack'
import { bundleFilename, downloadBytes, exportBundle, exportCardPngs, importBundle, type BundleLog } from '@/lib/library/bundle'
import { getProviderLink } from '@/lib/library/links'
import { readZip } from '@/lib/library/zip'
import { errorMessage, toastSuccess } from '@/lib/store/useToastStore'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Toggle } from '@/components/ui/Toggle'

type LogLine = { text: string; level: 'info' | 'warn' | 'error' }

function LogView({ lines }: { lines: LogLine[] }) {
  if (!lines.length) return null
  return (
    <div className="mt-3 max-h-56 min-h-0 overflow-y-auto rounded-xl bg-bg-sunken p-2 font-mono text-[11px] leading-relaxed">
      {lines.map((l, i) => (
        <div key={i} className={l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warning' : 'text-text-muted'}>
          {l.text}
        </div>
      ))}
    </div>
  )
}

function useLog(): [LogLine[], BundleLog, () => void] {
  const [lines, setLines] = useState<LogLine[]>([])
  return [lines, (text, level = 'info') => setLines((l) => [...l, { text, level }]), () => setLines([])]
}

type ExportMode = 'bundle' | 'cards' | 'links'

/** Multi-select export: full bundle (.zip), card PNGs (.zip), or provider links to the clipboard. */
export function ExportDialog({ characters, onClose }: { characters: Character[]; onClose: () => void }) {
  const [mode, setMode] = useState<ExportMode>('bundle')
  const [opts, setOpts] = useState({ chats: true, media: true, lorebooks: true })
  const [busy, setBusy] = useState(false)
  const [lines, log, clear] = useLog()
  const linked = characters.map((c) => getProviderLink(c.card)).filter((l) => l?.url)

  const run = async () => {
    clear()
    setBusy(true)
    try {
      if (mode === 'links') {
        await navigator.clipboard.writeText(linked.map((l) => l!.url).join('\n'))
        log(`Copied ${linked.length} link${linked.length === 1 ? '' : 's'} (${characters.length - linked.length} unlinked skipped).`)
      } else if (mode === 'cards') {
        downloadBytes(await exportCardPngs(characters, log), `rp-cards-${characters.length}.zip`)
        log('Done.')
      } else {
        downloadBytes(await exportBundle(characters, opts, log), bundleFilename(characters.length))
        log('Done.')
      }
    } catch (e) {
      log(`Export failed: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Export ${characters.length} character${characters.length === 1 ? '' : 's'}`} size="lg" scrollable onClose={onClose}>
      <SegmentedControl
        fill
        value={mode}
        onChange={setMode}
        className="mb-3"
        options={[
          { value: 'bundle', label: 'Full bundle' },
          { value: 'cards', label: 'Card PNGs' },
          { value: 'links', label: 'Provider links' },
        ]}
      />
      {mode === 'bundle' && (
        <div className="space-y-1">
          <p className="mb-2 text-xs text-text-muted">
            One .zip with each character's full pack (sprites, CGs and all), plus what you pick below. Import it on another RP Suite from the library's Import button.
          </p>
          <Toggle checked={opts.chats} onChange={(v) => setOpts((o) => ({ ...o, chats: v }))} label="Chats with full transcripts" />
          <Toggle checked={opts.media} onChange={(v) => setOpts((o) => ({ ...o, media: v }))} label="Gallery media" />
          <Toggle checked={opts.lorebooks} onChange={(v) => setOpts((o) => ({ ...o, lorebooks: v }))} label="Linked World Info books" />
        </div>
      )}
      {mode === 'cards' && <p className="text-xs text-text-muted">Each card as a SillyTavern-compatible PNG with the card embedded, zipped together.</p>}
      {mode === 'links' && (
        <p className="text-xs text-text-muted">
          {linked.length} of {characters.length} selected are linked to an online source.
        </p>
      )}
      <LogView lines={lines} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={busy || (mode === 'links' && !linked.length)} onClick={run}>
          {busy ? 'Working…' : mode === 'links' ? 'Copy links' : 'Export'}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Drag-and-drop import for everything the library understands: RP Suite bundles (.zip with
 * bundle.json), zips of card files, SillyTavern/V2/V3 card PNG/JSON, and `.rppack.json` packs.
 */
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported?: (ids: string[]) => void }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [lines, log] = useLog()
  const inputRef = useRef<HTMLInputElement>(null)

  const importCardFile = async (file: File): Promise<string | undefined> => {
    if (file.name.toLowerCase().endsWith('.rppack.json')) {
      const { character } = await importCharacterPack(await parseCharacterPackFile(file))
      return character.id
    }
    const result = await importCharacterFile(file)
    const created = await charactersApi.create({
      card: result.card,
      avatarDataUrl: result.avatarDataUrl,
      sprites: result.sprites,
      customExpressions: result.customExpressions,
    })
    return created.id
  }

  const handle = async (files: File[]) => {
    setBusy(true)
    const ids: string[] = []
    for (const file of files) {
      const lower = file.name.toLowerCase()
      try {
        if (lower.endsWith('.zip')) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const entries = await readZip(bytes)
          if (entries.some((e) => e.path === 'bundle.json')) {
            log(`${file.name}: library bundle`)
            const { characters } = await importBundle(bytes, log)
            ids.push(...characters.map((c) => c.id))
          } else {
            const cards = entries.filter((e) => /\.(png|json)$/i.test(e.path))
            log(`${file.name}: ${cards.length} card file${cards.length === 1 ? '' : 's'}`)
            for (const entry of cards) {
              const name = entry.path.split('/').pop()!
              try {
                const type = name.toLowerCase().endsWith('.png') ? 'image/png' : 'application/json'
                const id = await importCardFile(new File([entry.data as BlobPart], name, { type }))
                if (id) ids.push(id)
                log(`  ${name}: imported`)
              } catch (e) {
                log(`  ${name}: ${errorMessage(e)}`, 'error')
              }
            }
          }
        } else if (/\.(png|json)$/.test(lower)) {
          const id = await importCardFile(file)
          if (id) ids.push(id)
          log(`${file.name}: imported`)
        } else {
          log(`${file.name}: unsupported file type`, 'warn')
        }
      } catch (e) {
        log(`${file.name}: ${errorMessage(e)}`, 'error')
      }
    }
    setBusy(false)
    if (ids.length) {
      toastSuccess(`Imported ${ids.length} character${ids.length === 1 ? '' : 's'}.`)
      onImported?.(ids)
    }
  }

  return (
    <Modal title="Import characters" size="lg" scrollable onClose={onClose}>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (!busy) void handle([...e.dataTransfer.files])
        }}
        onClick={() => !busy && inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? 'border-accent bg-accent/5' : 'border-border hover:border-text-muted/40'
        }`}
      >
        <Upload size={26} className="mb-2 text-text-muted" />
        <p className="text-sm text-text">{busy ? 'Importing…' : 'Drop files here, or click to browse'}</p>
        <p className="mt-1 text-xs text-text-muted">Library bundles (.zip), zips of cards, card PNG/JSON (SillyTavern V1/V2/V3), .rppack.json</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".zip,.png,.json"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void handle([...e.target.files])
            e.target.value = ''
          }}
        />
      </div>
      <LogView lines={lines} />
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  )
}
