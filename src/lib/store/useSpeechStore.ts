import { create } from 'zustand'
import type { Character } from '@/lib/characters/cardSpec'
import { useSettingsStore } from '@/lib/store/useSettingsStore'
import { errorMessage, toastError } from '@/lib/store/useToastStore'
import { synthesizeSpeech } from '@/lib/voice/ttsProviders'
import { ttsConfigFor } from '@/lib/voice/ttsConfig'

/**
 * The app's single read-aloud player, shared by VN mode's per-line button, the chat view's
 * per-message buttons and auto-read of new replies (`useChatSession`), so none of them can talk
 * over another and every button reflects whatever is playing. Takes text already reduced to what should be spoken
 * (`extractReadAloudText`); reads the voice config from Settings at call time.
 */
type SpeakState = 'idle' | 'loading' | 'playing'

interface SpeechState {
  state: SpeakState
  /** The chat message being read, when the caller said which one (lights up that bubble's button). */
  messageId: string | null
  /** Cancels anything already playing, then synthesizes and plays `text`. Errors surface as a toast. */
  speak: (text: string, voice?: Character['voice'], messageId?: string) => Promise<void>
  stop: () => void
}

let controller: AbortController | null = null
let audio: HTMLAudioElement | null = null
let audioUrl: string | null = null

export const useSpeechStore = create<SpeechState>((set, get) => ({
  state: 'idle',
  messageId: null,
  stop: () => {
    controller?.abort()
    controller = null
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
      audioUrl = null
    }
    audio?.pause()
    audio = null
    set({ state: 'idle', messageId: null })
  },
  speak: async (text, voice, messageId) => {
    get().stop()
    if (!text.trim()) return
    set({ state: 'loading', messageId: messageId ?? null })
    const own = new AbortController()
    controller = own
    try {
      const blob = await synthesizeSpeech(ttsConfigFor(voice), text, useSettingsStore.getState().baseUrl, own.signal)
      own.signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      const el = new Audio(url)
      audioUrl = url
      audio = el
      set({ state: 'playing' })
      const finish = () => {
        URL.revokeObjectURL(url)
        if (audio === el) {
          audio = null
          audioUrl = null
          set({ state: 'idle', messageId: null })
        }
      }
      el.onended = finish
      el.onerror = finish
      try {
        await el.play()
      } catch (error) {
        finish()
        throw error
      }
    } catch (e) {
      if (own.signal.aborted) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) toastError(errorMessage(e))
        return
      }
      if (controller === own) set({ state: 'idle', messageId: null })
      toastError(errorMessage(e))
    }
  },
}))
