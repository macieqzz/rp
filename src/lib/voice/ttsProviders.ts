// Multi-provider text-to-speech. Every provider returns a playable audio Blob from
// plain text — a caller doesn't need to know which provider is behind it.

import { speakOpenMayhem } from '../api/openMayhemMedia'

export type TtsProviderId = 'koboldcpp' | 'openai-compatible' | 'chat-audio' | 'elevenlabs' | 'azure' | 'alibaba' | 'openmayhem'

export interface TtsConfig {
  provider: TtsProviderId
  apiKey?: string
  /** For 'openai-compatible' only — e.g. a local Kokoro-FastAPI server. koboldcpp reuses the app's own connection URL instead. */
  baseUrl?: string
  /** Azure region, e.g. "eastus". */
  region?: string
  voice: string
  model?: string
}

export const TTS_PROVIDER_LABELS: Record<TtsProviderId, string> = {
  openmayhem: 'OpenMayhem (hosted)',
  koboldcpp: 'KoboldCpp (local)',
  'openai-compatible': 'OpenAI-compatible (incl. local Kokoro)',
  'chat-audio': 'Chat connection audio model (gpt-audio on Nous / OpenRouter)',
  elevenlabs: 'ElevenLabs',
  azure: 'Microsoft / Azure Speech',
  alibaba: 'Alibaba Cloud Model Studio',
}

async function speakOpenAiCompatible(baseUrl: string, apiKey: string | undefined, text: string, voice: string): Promise<Blob> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: 'tts-1', input: text, voice: voice || 'alloy' }),
  })
  if (!res.ok) throw new Error(`TTS request to ${baseUrl} failed (${res.status})`)
  return res.blob()
}

/** Defaults for `chat-audio` when the Model / Voice fields are left empty. */
export const CHAT_AUDIO_DEFAULT_MODEL = 'openai/gpt-audio-mini'
export const CHAT_AUDIO_DEFAULT_VOICE = 'coral'
export const CHAT_AUDIO_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']

/** gpt-audio streams raw 16-bit little-endian mono PCM at 24 kHz; a browser `<audio>` needs a container around it. */
function pcm16ToWav(pcm: Uint8Array<ArrayBuffer>, sampleRate = 24000): Blob {
  const header = new DataView(new ArrayBuffer(44))
  const ascii = (offset: number, text: string) => [...text].forEach((c, i) => header.setUint8(offset + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  header.setUint32(4, 36 + pcm.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true) // PCM
  header.setUint16(22, 1, true) // mono
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * 2, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  ascii(36, 'data')
  header.setUint32(40, pcm.length, true)
  return new Blob([header.buffer, pcm], { type: 'audio/wav' })
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Speech from an audio-output chat model (OpenAI's gpt-audio family) reached through the chat
 * connection — the Nous Portal and OpenRouter carry these but have no `/audio/speech` endpoint.
 * The model is told to read the line verbatim, in whatever language it's written in. Audio output
 * is only offered streamed, as base64 PCM chunks on `delta.audio.data`.
 */
async function speakChatAudio(baseUrl: string, apiKey: string | undefined, model: string, voice: string, text: string, signal?: AbortSignal): Promise<Blob> {
  if (!baseUrl) throw new Error('Set up a hosted chat backend in Settings → Connection first; this voice uses its base URL and key.')
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model: model || CHAT_AUDIO_DEFAULT_MODEL,
      stream: true,
      modalities: ['text', 'audio'],
      audio: { voice: voice || CHAT_AUDIO_DEFAULT_VOICE, format: 'pcm16' },
      messages: [
        {
          role: 'system',
          content:
            "You are a voice actor. Read the user's text aloud exactly as written, in the language it is written in, with natural emotion that fits it. Do not add, remove, translate or comment on anything.",
        },
        { role: 'user', content: text },
      ],
    }),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Audio model request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const chunks: Uint8Array[] = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const payload = line.trim()
      if (!payload.startsWith('data:') || payload === 'data: [DONE]') continue
      try {
        const event = JSON.parse(payload.slice(5)) as { choices?: { delta?: { audio?: { data?: string } } }[] }
        const data = event.choices?.[0]?.delta?.audio?.data
        if (data) chunks.push(base64ToBytes(data))
      } catch {
        // Keep-alive comments and partial lines carry no audio.
      }
    }
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  if (!total) throw new Error('The audio model replied without any audio. Check that the selected model supports audio output.')
  const pcm = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    pcm.set(c, offset)
    offset += c.length
  }
  return pcm16ToWav(pcm)
}

async function speakElevenLabs(apiKey: string, voiceId: string, text: string): Promise<Blob> {
  if (!apiKey) throw new Error('ElevenLabs needs an API key (Settings → Voice)')
  if (!voiceId) throw new Error('ElevenLabs needs a voice ID (Settings → Voice)')
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  })
  if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status})`)
  return res.blob()
}

function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function speakAzure(apiKey: string, region: string, voiceName: string, text: string): Promise<Blob> {
  if (!apiKey || !region) throw new Error('Azure Speech needs a subscription key and region (Settings → Voice)')
  const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${voiceName || 'en-US-JennyNeural'}">${escapeSsml(text)}</voice></speak>`
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/ssml+xml',
      'Ocp-Apim-Subscription-Key': apiKey,
      'X-Microsoft-OutputFormat': 'audio-16khz-64kbitrate-mono-mp3',
    },
    body: ssml,
  })
  if (!res.ok) throw new Error(`Azure Speech TTS failed (${res.status})`)
  return res.blob()
}

/**
 * Synthesizes speech for the given text using whichever provider is configured.
 * `koboldBaseUrl` is the app's own KoboldCpp connection URL (Settings → Connection) —
 * koboldcpp exposes an OpenAI-compatible /v1/audio/speech endpoint, so the local
 * provider is just the same call pointed at that URL with no API key.
 */
export async function synthesizeSpeech(config: TtsConfig, text: string, koboldBaseUrl: string, signal?: AbortSignal): Promise<Blob> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Nothing to speak')
  // A pasted key/id/region with a trailing space or newline is a common, silent cause of a 401 —
  // trimmed here (at the point of use) rather than on every keystroke in Settings, so it also
  // heals a key that's already saved with stray whitespace, without fighting the user mid-type.
  const apiKey = config.apiKey?.trim()
  const voice = config.voice?.trim() ?? ''
  const baseUrl = config.baseUrl?.trim()
  const region = config.region?.trim()

  switch (config.provider) {
    case 'openmayhem':
      return speakOpenMayhem(apiKey || '', config.model || '', trimmed, voice, signal)
    case 'koboldcpp':
      return speakOpenAiCompatible(koboldBaseUrl, undefined, trimmed, voice)
    case 'openai-compatible':
      if (!baseUrl) throw new Error('Set a server URL for the OpenAI-compatible provider (Settings → Voice)')
      return speakOpenAiCompatible(baseUrl, apiKey, trimmed, voice)
    case 'chat-audio':
      return speakChatAudio(baseUrl ?? '', apiKey, config.model?.trim() ?? '', voice, trimmed, signal)
    case 'elevenlabs':
      return speakElevenLabs(apiKey ?? '', voice, trimmed)
    case 'azure':
      return speakAzure(apiKey ?? '', region ?? '', voice, trimmed)
    case 'alibaba':
      // DashScope's TTS request/response shape hasn't been confirmed against a live account —
      // rather than guess at an API contract, this is left honestly unimplemented.
      throw new Error('Alibaba Cloud Model Studio isn\'t wired up yet. The other providers are ready to use.')
  }
}

/** Voices available for the local koboldcpp TTS model, if one is loaded. */
export async function listKoboldSpeakers(koboldBaseUrl: string): Promise<string[]> {
  const res = await fetch(`${koboldBaseUrl.replace(/\/+$/, '')}/api/extra/speakers_list`)
  if (!res.ok) return []
  const data = (await res.json().catch(() => null)) as { speakers?: { name?: string }[] } | null
  return Array.isArray(data?.speakers) ? data.speakers.map((s) => s.name).filter((n): n is string => !!n) : []
}
