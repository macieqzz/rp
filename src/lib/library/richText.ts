/**
 * Renders card text (creator's notes, descriptions, greetings) — which in the wild is a mix of plain
 * text, Markdown, and full HTML/CSS layouts — into a standalone HTML document for a sandboxed
 * `<iframe srcdoc>`. The iframe runs with no `allow-scripts`/`allow-same-origin` and a strict CSP, so
 * the sanitizing here is defence in depth: scripts, frames, forms, event handlers and `javascript:`
 * URLs are stripped before the document is even built.
 */

const DANGEROUS_BLOCKS = /<(script|iframe|frame|frameset|object|embed|applet|noscript|template)\b[\s\S]*?(<\/\1\s*>|$)/gi
const DANGEROUS_SINGLE = /<\/?(script|iframe|frame|frameset|object|embed|applet|meta|base|link|form|input|button|textarea|select|option)\b[^>]*>/gi
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const SCRIPT_URL = /\b(href|src|xlink:href|action|formaction|poster|background)\s*=\s*("|')?\s*(javascript|vbscript|data:text\/html)[^"'>\s]*\2?/gi
const CSS_EXPRESSION = /expression\s*\(|-moz-binding|behavior\s*:/gi

/** Strips everything that could execute or navigate; leaves layout HTML/CSS and media intact. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DANGEROUS_BLOCKS, '')
    .replace(DANGEROUS_SINGLE, '')
    .replace(EVENT_ATTR, '')
    .replace(SCRIPT_URL, '$1="#"')
    .replace(CSS_EXPRESSION, 'blocked(')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function safeUrl(url: string): string {
  const u = url.trim()
  return /^(https?:|data:image\/|\/|#|mailto:)/i.test(u) ? escapeHtml(u) : '#'
}

/** Block-level tags whose presence means the author laid the text out with HTML themselves. */
const BLOCK_HTML = /<(div|p|table|ul|ol|section|article|style|center|h[1-6]|br|hr|blockquote|pre|details|figure)\b/i

/**
 * Minimal Markdown for the text between HTML tags: images, links, headings, bold/italic, inline
 * code, rules. Raw HTML is passed through (then sanitized). Plain newlines become `<br>` unless the
 * author is already doing block layout in HTML, where they'd only add stray gaps.
 */
export function markdownToHtml(text: string): string {
  const layoutHtml = BLOCK_HTML.test(text)
  // Split into HTML tags vs text runs, and leave <style>/<pre> bodies completely alone.
  const parts = text.split(/(<style\b[\s\S]*?<\/style>|<pre\b[\s\S]*?<\/pre>|<[^>]+>)/gi)
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part
    let s = part
      .replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_m, alt: string, url: string) => `<img src="${safeUrl(url)}" alt="${escapeHtml(alt)}">`)
      .replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_m, label: string, url: string) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      .replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes: string, title: string) => `<h${hashes.length}>${title}</h${hashes.length}>`)
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    if (!layoutHtml) s = s.replace(/\n/g, '<br>\n')
    return s
  })
  return out.join('')
}

/** `{{char}}`/`{{user}}` macros, the two every card uses. */
export function substituteMacros(text: string, names: { char: string; user: string }): string {
  return text.replace(/\{\{char\}\}|<BOT>/gi, names.char).replace(/\{\{user\}\}|<USER>/gi, names.user)
}

/** Replaces remote media URLs with their downloaded local copies (exact string match). */
export function localizeUrls(html: string, map: Record<string, string>): string {
  let out = html
  for (const [remote, local] of Object.entries(map)) if (remote) out = out.split(remote).join(local)
  return out
}

export interface RenderOptions {
  names: { char: string; user: string }
  /** Absolute origin of the app, so `/avatars/...` resolves inside the opaque-origin iframe. */
  origin: string
  /** CSS colour values for the document's base text/link/background colours. */
  colors: { text: string; muted: string; accent: string; background: string }
  localize?: Record<string, string>
}

/** The full `srcdoc` document for one piece of card text. */
export function renderCardDocument(text: string, opts: RenderOptions): string {
  let body = sanitizeHtml(markdownToHtml(substituteMacros(text, opts.names)))
  if (opts.localize) body = localizeUrls(body, opts.localize)
  const origin = escapeHtml(opts.origin)
  const csp = [
    "default-src 'none'",
    `img-src ${origin} https: http: data: blob:`,
    `media-src ${origin} https: http: data: blob:`,
    "style-src 'unsafe-inline' https:",
    'font-src https: data:',
  ].join('; ')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${origin}/" target="_blank"><style>
html,body{margin:0;padding:0;background:${opts.colors.background};color:${opts.colors.text};font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;overflow-wrap:anywhere}
body{padding:12px 14px}
a{color:${opts.colors.accent}}
img,video{max-width:100%;height:auto;border-radius:8px}
em{color:${opts.colors.muted}}
code{background:rgba(127,127,127,.18);padding:0 4px;border-radius:4px}
hr{border:0;border-top:1px solid rgba(127,127,127,.35)}
table{border-collapse:collapse;max-width:100%}td,th{border:1px solid rgba(127,127,127,.3);padding:4px 6px}
</style></head><body>${body}</body></html>`
}
