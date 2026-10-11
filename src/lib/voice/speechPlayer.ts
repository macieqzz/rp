// One app-wide "read this message aloud" player for the ordinary chat view. Each bubble's speaker
// button and the chat's auto-voice both go through it, so starting one line always cuts off the
// previous one instead of two clips talking over each other.

import { create } from 'zustand'
import type { Character } from '@/lib/characters/cardSpec'
import { useSettingsStore } from '@/lib/store/useSettingsStore'
import { errorMessage, toastError } from '@/lib/store/useToastStore'
import { toSpeakableText } from './speakableText'
import { synthesizeSpeech, type TtsConfig } from './ttsProviders'

export type SpeechStatus = 'idle' | 'loading' | 'playing'

/** The configured TTS setup, with a character's own voice override (if any) applied on top. */
export function ttsConfigFor(voice?: Character['voice']): TtsConfig {
  const s = useSettingsStore.getState()
  if (voice?.provider && voice.provider !== s.ttsProvider) {
    throw new Error('This character overrides the voice provider. Select that provider in Settings → Voice first, or use the global default for this character.')
  }
  return {
    provider: voice?.provider ?? s.ttsProvider,
    apiKey: s.ttsProvider === 'openmayhem' ? s.openMayhemApiKey : s.ttsApiKey,
    model: s.ttsModel,
    baseUrl: s.ttsBaseUrl,
    region: s.ttsRegion,
    voice: voice?.voiceId || s.ttsVoice,
  }
}

interface SpeechPlayerState {
  /** Message currently loading or playing, or null. */
  messageId: string | null
  status: SpeechStatus
  speak: (messageId: string, text: string, voice?: Character['voice']) => Promise<void>
  stop: () => void
}

let controller: AbortController | null = null
let audio: HTMLAudioElement | null = null
let objectUrl: string | null = null

function release() {
  controller?.abort()
  controller = null
  audio?.pause()
  audio = null
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = null
}

export const useSpeechPlayer = create<SpeechPlayerState>((set, get) => ({
  messageId: null,
  status: 'idle',
  stop: () => {
    release()
    set({ messageId: null, status: 'idle' })
  },
  speak: async (messageId, text, voice) => {
    release()
    const speakable = toSpeakableText(text)
    if (!speakable) return set({ messageId: null, status: 'idle' })
    const own = new AbortController()
    controller = own
    set({ messageId, status: 'loading' })
    try {
      const blob = await synthesizeSpeech(ttsConfigFor(voice), speakable, useSettingsStore.getState().baseUrl, own.signal)
      own.signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      const clip = new Audio(url)
      objectUrl = url
      audio = clip
      const finish = () => {
        if (audio !== clip) return
        controller = null // done with this request; aborting it now would hide a play() failure below
        release()
        set({ messageId: null, status: 'idle' })
      }
      clip.onended = finish
      clip.onerror = finish
      set({ status: 'playing' })
      try {
        await clip.play()
      } catch (e) {
        finish()
        throw e
      }
    } catch (e) {
      // Superseded by another line or an explicit stop: whoever did that already owns the state.
      if (own.signal.aborted) return
      if (get().messageId === messageId) set({ messageId: null, status: 'idle' })
      toastError(errorMessage(e))
    }
  },
}))
