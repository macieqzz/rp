import { create } from 'zustand'
import type { Character } from '@/lib/characters/cardSpec'
import { useSettingsStore } from '@/lib/store/useSettingsStore'
import { errorMessage, toastError } from '@/lib/store/useToastStore'
import { synthesizeSpeech } from '@/lib/voice/ttsProviders'

/**
 * The app's single read-aloud player, shared by VN mode's per-line button and auto-read of new
 * replies (`useChatSession`), so the two can never talk over each other and the VN button always
 * reflects whatever is playing. Takes text already reduced to what should be spoken
 * (`extractReadAloudText`); reads the voice config from Settings at call time.
 */
type SpeakState = 'idle' | 'loading' | 'playing'

interface SpeechState {
  state: SpeakState
  /** Cancels anything already playing, then synthesizes and plays `text`. Errors surface as a toast. */
  speak: (text: string, voice?: Character['voice']) => Promise<void>
  stop: () => void
}

let controller: AbortController | null = null
let audio: HTMLAudioElement | null = null
let audioUrl: string | null = null

export const useSpeechStore = create<SpeechState>((set, get) => ({
  state: 'idle',
  stop: () => {
    controller?.abort()
    controller = null
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
      audioUrl = null
    }
    audio?.pause()
    audio = null
    set({ state: 'idle' })
  },
  speak: async (text, voice) => {
    get().stop()
    if (!text.trim()) return
    const s = useSettingsStore.getState()
    set({ state: 'loading' })
    const own = new AbortController()
    controller = own
    try {
      if (voice?.provider && voice.provider !== s.ttsProvider) {
        throw new Error('This character overrides the voice provider. Select that provider in Settings → Voice first, or use the global default for this character.')
      }
      const blob = await synthesizeSpeech(
        {
          provider: voice?.provider ?? s.ttsProvider,
          apiKey: s.ttsProvider === 'openmayhem' ? s.openMayhemApiKey : s.ttsApiKey,
          model: s.ttsModel,
          baseUrl: s.ttsBaseUrl,
          region: s.ttsRegion,
          voice: voice?.voiceId || s.ttsVoice,
        },
        text,
        s.baseUrl,
        own.signal,
      )
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
          set({ state: 'idle' })
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
      if (controller === own) set({ state: 'idle' })
      toastError(errorMessage(e))
    }
  },
}))
