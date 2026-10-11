import { useMemo, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { renderCardDocument } from '@/lib/library/richText'

/** Reads a theme token (`--c-text` = "r g b") as a CSS colour for the iframe's own stylesheet. */
function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v ? `rgb(${v.replace(/\s+/g, ' ')})` : fallback
}

/**
 * Card text (Markdown/HTML/CSS) rendered in a sandboxed iframe: no scripts, no same-origin access,
 * a CSP that only allows images/media/styles, and links that open in a new tab. Sized by the
 * caller; an expand toggle grows it for long creator's-notes layouts.
 */
export function RichTextFrame({
  text,
  names,
  localize,
  height = 260,
  title,
}: {
  text: string
  /** `{{char}}`/`{{user}}` substitutions. */
  names: { char: string; user: string }
  localize?: Record<string, string>
  height?: number
  title: string
}) {
  const [expanded, setExpanded] = useState(false)
  const doc = useMemo(
    () =>
      renderCardDocument(text, {
        names,
        origin: window.location.origin,
        colors: {
          text: themeColor('--c-text', '#e5e5e5'),
          muted: themeColor('--c-text-muted', '#a3a3a3'),
          accent: themeColor('--c-accent', '#a78bfa'),
          background: themeColor('--c-bg-sunken', '#111'),
        },
        localize,
      }),
    [text, names.char, names.user, localize],
  )
  if (!text.trim()) return <p className="text-sm italic text-text-muted">Empty.</p>
  return (
    <div className="relative">
      <iframe
        title={title}
        srcDoc={doc}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="w-full resize-y rounded-xl border border-border bg-bg-sunken"
        style={{ height: expanded ? '75vh' : height }}
      />
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Shrink' : 'Expand'}
        className="absolute right-2 top-2 rounded-md bg-bg-elevated/80 p-1 text-text-muted hover:text-text"
      >
        {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
    </div>
  )
}
