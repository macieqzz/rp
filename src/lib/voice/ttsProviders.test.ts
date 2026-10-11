import { afterEach, describe, expect, it, vi } from 'vitest'
import { listKoboldSpeakers, synthesizeSpeech, TTS_PROVIDER_LABELS } from './ttsProviders'

function okBlobResponse(): Response {
  return { ok: true, status: 200, blob: async () => new Blob(['audio']) } as unknown as Response
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

afterEach(() => vi.unstubAllGlobals())

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      // Split mid-line on purpose so the reader has to stitch events back together.
      const text = lines.map((l) => `${l}\n\n`).join('')
      controller.enqueue(enc.encode(text.slice(0, 25)))
      controller.enqueue(enc.encode(text.slice(25)))
      controller.close()
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

describe('synthesizeSpeech', () => {
  it('throws without calling fetch when the text is empty or whitespace-only', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(synthesizeSpeech({ provider: 'koboldcpp', voice: '' }, '   ', 'http://localhost:5001')).rejects.toThrow(
      'Nothing to speak',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('koboldcpp posts to the app connection URL with no Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)
    const blob = await synthesizeSpeech({ provider: 'koboldcpp', voice: 'narrator' }, 'Hello', 'http://localhost:5001/')
    expect(blob).toBeInstanceOf(Blob)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:5001/v1/audio/speech')
    expect(init.headers.Authorization).toBeUndefined()
    expect(JSON.parse(init.body)).toEqual({ model: 'tts-1', input: 'Hello', voice: 'narrator' })
  })

  it('koboldcpp defaults the voice to "alloy" when none is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)
    await synthesizeSpeech({ provider: 'koboldcpp', voice: '' }, 'Hi', 'http://localhost:5001')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).voice).toBe('alloy')
  })

  it('trims the spoken text before sending it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)
    await synthesizeSpeech({ provider: 'koboldcpp', voice: 'x' }, '  Hello there.  ', 'http://localhost:5001')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toBe('Hello there.')
  })

  it('openai-compatible requires a server URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      synthesizeSpeech({ provider: 'openai-compatible', voice: 'alloy' }, 'Hi', 'http://localhost:5001'),
    ).rejects.toThrow('Set a server URL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('openai-compatible sends a Bearer Authorization header when an API key is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)
    await synthesizeSpeech(
      { provider: 'openai-compatible', baseUrl: 'http://localhost:8880', apiKey: 'sk-test', voice: 'bella' },
      'Hi',
      'http://localhost:5001',
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8880/v1/audio/speech')
    expect(init.headers.Authorization).toBe('Bearer sk-test')
  })

  it('elevenlabs requires an API key and a voice ID', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(synthesizeSpeech({ provider: 'elevenlabs', voice: '' }, 'Hi', 'x')).rejects.toThrow('needs an API key')
    await expect(synthesizeSpeech({ provider: 'elevenlabs', apiKey: 'k', voice: '' }, 'Hi', 'x')).rejects.toThrow(
      'needs a voice ID',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('elevenlabs posts to the voice-specific endpoint with the xi-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)
    await synthesizeSpeech({ provider: 'elevenlabs', apiKey: 'k123', voice: 'voice/1' }, 'Hi', 'x')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice%2F1')
    expect(init.headers['xi-api-key']).toBe('k123')
    expect(JSON.parse(init.body)).toEqual({ text: 'Hi', model_id: 'eleven_multilingual_v2' })
  })

  it('azure requires a subscription key and region', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(synthesizeSpeech({ provider: 'azure', voice: '' }, 'Hi', 'x')).rejects.toThrow('needs a subscription key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('azure builds region-scoped SSML and escapes special characters in the text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)
    await synthesizeSpeech({ provider: 'azure', apiKey: 'k', region: 'eastus', voice: 'en-US-JennyNeural' }, 'Tom & "Jerry" <hi>', 'x')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1')
    expect(init.headers['Ocp-Apim-Subscription-Key']).toBe('k')
    expect(init.body).toContain('Tom &amp; &quot;Jerry&quot; &lt;hi&gt;')
    expect(init.body).toContain('en-US-JennyNeural')
  })

  it('azure defaults the voice name when none is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)
    await synthesizeSpeech({ provider: 'azure', apiKey: 'k', region: 'eastus', voice: '' }, 'Hi', 'x')
    expect(fetchMock.mock.calls[0][1].body).toContain('en-US-JennyNeural')
  })

  it('alibaba is deliberately left unimplemented and never calls fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(synthesizeSpeech({ provider: 'alibaba', voice: '' }, 'Hi', 'x')).rejects.toThrow("isn't wired up yet")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('every provider has a label, including the unimplemented one', () => {
    expect(Object.keys(TTS_PROVIDER_LABELS).sort()).toEqual(
      ['alibaba', 'azure', 'chat-audio', 'elevenlabs', 'koboldcpp', 'openai-compatible', 'openmayhem'].sort(),
    )
  })

  it('surfaces a non-ok response as a descriptive error including the status code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response))
    await expect(synthesizeSpeech({ provider: 'koboldcpp', voice: 'x' }, 'Hi', 'http://localhost:5001')).rejects.toThrow(
      '503',
    )
  })
})

describe('listKoboldSpeakers', () => {
  it('returns speaker names from the speakers_list endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { speakers: [{ name: 'narrator' }, { name: 'heroine' }] })),
    )
    expect(await listKoboldSpeakers('http://localhost:5001/')).toEqual(['narrator', 'heroine'])
  })

  it('filters out entries with no usable name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { speakers: [{ name: 'a' }, {}, { name: '' }] })))
    expect(await listKoboldSpeakers('http://localhost:5001')).toEqual(['a'])
  })

  it('degrades to [] on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 } as unknown as Response))
    expect(await listKoboldSpeakers('http://localhost:5001')).toEqual([])
  })

  it('degrades to [] when the payload has no speakers array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })))
    expect(await listKoboldSpeakers('http://localhost:5001')).toEqual([])
  })

  it('degrades to [] when the response body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => Promise.reject(new Error('bad json')) } as unknown as Response),
    )
    expect(await listKoboldSpeakers('http://localhost:5001')).toEqual([])
  })

  it('chat-audio streams gpt-audio PCM through the chat connection and wraps it as WAV', async () => {
    const pcmA = btoa(String.fromCharCode(1, 2, 3, 4))
    const pcmB = btoa(String.fromCharCode(5, 6))
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcmA, transcript: 'Cześć' } } }] })}`,
        ': OPENROUTER PROCESSING',
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcmB } } }] })}`,
        'data: [DONE]',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const blob = await synthesizeSpeech(
      { provider: 'chat-audio', baseUrl: 'https://inference-api.nousresearch.com/v1/', apiKey: 'k', voice: '', model: '' },
      'Cześć',
      'http://localhost:5001',
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://inference-api.nousresearch.com/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer k')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ model: 'openai/gpt-audio-mini', stream: true, modalities: ['text', 'audio'], audio: { voice: 'coral', format: 'pcm16' } })
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Cześć' })
    expect(blob.type).toBe('audio/wav')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(bytes.length).toBe(44 + 6)
    expect([...bytes.slice(44)]).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('chat-audio says so when the model sent no audio at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}`, 'data: [DONE]'])))
    await expect(
      synthesizeSpeech({ provider: 'chat-audio', baseUrl: 'https://x.example/v1', apiKey: 'k', voice: 'coral' }, 'Hi', ''),
    ).rejects.toThrow(/without any audio/)
  })
})
