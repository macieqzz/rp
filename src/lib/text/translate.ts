import { extractSceneTag } from '@/lib/vn/sceneTag'
import type { StoredMessage } from '@/lib/types'
import { useSettingsStore } from '@/lib/store/useSettingsStore'

// Display-only reply translation (Settings → Connection → Reply translation).
// Uses Google Translate API proxied through the local server to avoid CORS/IP bans.
// Scoring, flags and scene/expression parsing all run on the original text.

export async function translateReply(
  text: string,
  opts: {
    language: string
    signal?: AbortSignal
  },
): Promise<string> {
  if (!text.trim()) return text
  const baseUrl = useSettingsStore.getState().baseUrl
  const res = await fetch(`${baseUrl}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, targetLang: opts.language }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Server returned ${res.status}`)
  }
  const data = await res.json()
  if (!data.translated) throw new Error('Translation came back empty.')
  return data.translated
}

/** The translation to show for this message's current text, or undefined to show the original. */
export function activeTranslation(message: Pick<StoredMessage, 'text' | 'activeSwipe' | 'swipeTranslations'>): string | undefined {
  const t = message.swipeTranslations?.[message.activeSwipe ?? 0]
  return t && t.source === message.text && t.text ? t.text : undefined
}
