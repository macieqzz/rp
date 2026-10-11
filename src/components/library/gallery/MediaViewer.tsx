import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, Music, RotateCcw, X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import type { MediaItem } from '@/lib/library/types'

const MAX_ZOOM = 5
const ZOOM_STEP = 1.2
const RESET_VIEW = { scale: 1, x: 0, y: 0 }

/**
 * Full-screen viewer for a character's library media: wheel-zoom (up to 5x) and drag-to-pan for
 * images, native controls for video/audio, ← → to step through `items`, 0 to reset zoom, Esc to
 * close. Portaled to `<body>` because it opens from inside the details Modal, whose animated
 * panel would otherwise become the containing block of this `fixed` overlay.
 */
export function MediaViewer({
  items,
  index,
  onClose,
  onIndexChange,
}: {
  items: MediaItem[]
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
}) {
  const item = items[index] as MediaItem | undefined
  const count = items.length
  const [view, setView] = useState(RESET_VIEW)
  const overlayRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  /** Pointer offset from the pan origin while dragging, plus whether it moved (a drag isn't a backdrop click). */
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)
  const draggedRef = useRef(false)
  useFocusTrap(overlayRef, true)

  useEffect(() => setView(RESET_VIEW), [index])

  useEffect(() => {
    const step = (delta: number) => {
      if (count > 1) onIndexChange((index + delta + count) % count)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === '0') setView(RESET_VIEW)
      else return
      // Capture phase on window runs before the details Modal's own Escape listener, so stopping
      // here closes just the viewer.
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [count, index, onClose, onIndexChange])

  // React's onWheel listener is passive, so it can't stop the page behind from scrolling — attach
  // a native non-passive one instead.
  const isImage = item?.kind === 'image'
  useEffect(() => {
    const el = stageRef.current
    if (!el || !isImage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setView((v) => {
        const scale = Math.min(MAX_ZOOM, Math.max(1, e.deltaY < 0 ? v.scale * ZOOM_STEP : v.scale / ZOOM_STEP))
        if (scale === 1) return RESET_VIEW
        const ratio = scale / v.scale
        return { scale, x: v.x * ratio, y: v.y * ratio }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isImage])

  if (!item) return null

  const zoomed = isImage && view.scale > 1

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer: ${item.name}`}
      tabIndex={-1}
      className="animate-overlay-in fixed inset-0 z-50 flex flex-col bg-black/90 text-white"
    >
      <div className="flex shrink-0 items-center gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </p>
          <p className="text-[11px] text-white/60">
            {index + 1} / {count}
            {isImage && view.scale > 1 && ` · ${Math.round(view.scale * 100)}%`}
          </p>
        </div>
        {isImage && <IconButton icon={RotateCcw} title="Reset zoom (0)" tone="glass" onClick={() => setView(RESET_VIEW)} disabled={!zoomed} />}
        <a
          href={item.url}
          download={item.name}
          title="Download"
          aria-label="Download"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/15 hover:text-white"
        >
          <Download size={17} strokeWidth={1.75} />
        </a>
        <IconButton icon={X} title="Close (Esc)" tone="glass" onClick={onClose} />
      </div>

      <div
        ref={stageRef}
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 ${zoomed ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onClick={(e) => {
          if (e.target === e.currentTarget && !draggedRef.current) onClose()
          draggedRef.current = false
        }}
        onPointerDown={(e) => {
          if (!zoomed || e.button !== 0 || (e.target as Element).closest('button')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { dx: e.clientX - view.x, dy: e.clientY - view.y, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const x = e.clientX - d.dx
          const y = e.clientY - d.dy
          if (Math.abs(x - view.x) + Math.abs(y - view.y) > 2) d.moved = true
          setView((v) => ({ ...v, x, y }))
        }}
        onPointerUp={() => {
          draggedRef.current = drag.current?.moved ?? false
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        {item.kind === 'image' && (
          <img
            key={item.url}
            src={item.url}
            alt={item.name}
            draggable={false}
            onDoubleClick={() => setView((v) => (v.scale > 1 ? RESET_VIEW : { scale: 2.5, x: 0, y: 0 }))}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            className="max-h-full max-w-full select-none object-contain"
          />
        )}
        {item.kind === 'video' && (
          <video key={item.url} src={item.url} controls autoPlay playsInline className="max-h-full max-w-full rounded-lg" />
        )}
        {item.kind === 'audio' && (
          <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl bg-white/10 p-6">
            <Music size={40} strokeWidth={1.5} className="text-white/70" />
            <p className="max-w-full truncate text-sm">{item.name}</p>
            <audio key={item.url} src={item.url} controls autoPlay className="w-full" />
          </div>
        )}

        {count > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous (←)"
              title="Previous (←)"
              onClick={() => onIndexChange((index - 1 + count) % count)}
              className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/80 transition-colors hover:bg-black/60 hover:text-white"
            >
              <ChevronLeft size={22} />
            </button>
            <button
              type="button"
              aria-label="Next (→)"
              title="Next (→)"
              onClick={() => onIndexChange((index + 1) % count)}
              className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/80 transition-colors hover:bg-black/60 hover:text-white"
            >
              <ChevronRight size={22} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
