import { describe, expect, it } from 'vitest'
import { chirpLang, createChirpEngine, createEdgeEngine, createOpenAIEngine, edgeRate, openaiRoot, xmlEscape } from '../src/index.js'
import type { EdgeClient } from '../src/index.js'
import { json } from './helpers.js'

const b64 = (s: string): string => Buffer.from(s).toString('base64')

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('chirp', () => {
  it('text:synthesize: голос, язык из имени, mp3 по запросу, темп — speakingRate, заголовки проекта', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const engine = createChirpEngine({
      project: 'proj-1',
      token: async () => 'tok-1',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init })
        return json({ audioContent: b64('MP3DATA') })
      }) as typeof fetch,
    })
    const [c] = await all(engine.speak('Привет', 'ru-RU-Chirp3-HD-Kore', { format: 'mp3', speed: 1.25 }))
    expect(new TextDecoder().decode(c!.data)).toBe('MP3DATA')
    expect(c!.mime).toBe('audio/mpeg')
    expect(seen[0]!.url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize')
    const h = seen[0]!.init.headers as Record<string, string>
    expect(h.authorization).toBe('Bearer tok-1')
    expect(h['x-goog-user-project']).toBe('proj-1')
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      input: { text: 'Привет' },
      voice: { languageCode: 'ru-RU', name: 'ru-RU-Chirp3-HD-Kore' },
      audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000, speakingRate: 1.25 },
    })
    expect(engine.nativeSpeed).toBe(true)
  })

  it('без mp3 — LINEAR16 (wav); 401 — одно обновление токена; каталог — только Chirp3-HD', async () => {
    let n = 0
    let tokens = 0
    const engine = createChirpEngine({
      project: 'p',
      token: async () => `t${++tokens}`,
      fetch: (async (url: string) => {
        n++
        if (url.includes('/voices')) return json({ voices: [{ name: 'ru-RU-Chirp3-HD-Aoede', ssmlGender: 'FEMALE', languageCodes: ['ru-RU'] }, { name: 'ru-RU-Wavenet-A' }] })
        if (n === 1) return json({ error: { message: 'expired' } }, 401)
        return json({ audioContent: b64('RIFF') })
      }) as typeof fetch,
    })
    const [c] = await all(engine.speak('x', '', {}))
    expect(c!.mime).toBe('audio/wav')
    expect(tokens).toBe(2)
    expect(await engine.voices()).toEqual([{ id: 'ru-RU-Chirp3-HD-Aoede', type: 'prebuilt', name: 'ru-RU-Chirp3-HD-Aoede', lang: 'ru-RU', gender: 'female' }])
    expect(chirpLang('en-US-Chirp3-HD-Puck')).toBe('en-US')
  })

  it('ошибка API — текст провайдера и статус', async () => {
    const engine = createChirpEngine({ project: 'p', token: async () => 't', fetch: (async () => json({ error: { message: 'API disabled' } }, 403)) as typeof fetch })
    await expect(all(engine.speak('x', '', {}))).rejects.toThrow(/chirp\.speak: HTTP 403 — API disabled/)
  })
})

describe('edge', () => {
  function client(o: { fail?: number; blocked?: boolean } = {}) {
    const log: string[] = []
    let failures = o.fail ?? 0
    const c: EdgeClient = {
      async *synth(text, voice, opts) {
        log.push(`start ${text}`)
        if (failures > 0) {
          failures--
          throw new Error(o.blocked === false ? 'boom' : 'Edge TTS WebSocket error: Unexpected server response: 403')
        }
        await new Promise((r) => setTimeout(r, 5))
        yield new TextEncoder().encode(`${voice}|${opts.rate}|${text}`)
        log.push(`end ${text}`)
      },
      async voices() {
        return [
          { ShortName: 'ru-RU-SvetlanaNeural', Gender: 'Female', Locale: 'ru-RU' },
          { ShortName: 'en-US-EmmaNeural', Gender: 'Female', Locale: 'en-US' },
        ]
      },
    }
    return { c, log }
  }

  it('mp3 как есть; SSML-экранирование; темп → rate; голос по умолчанию — Светлана; каталог ru-RU', async () => {
    const { c } = client()
    const engine = createEdgeEngine({ client: c })
    const [x] = await all(engine.speak('a < b & c', '', { speed: 1.2 }))
    expect(x!.mime).toBe('audio/mpeg')
    expect(new TextDecoder().decode(x!.data)).toBe('ru-RU-SvetlanaNeural|+20%|a &lt; b &amp; c')
    expect((await engine.voices()).map((v) => v.id)).toEqual(['ru-RU-SvetlanaNeural'])
    expect(edgeRate(0.8)).toBe('-20%')
    expect(xmlEscape('<&>')).toBe('&lt;&amp;&gt;')
  })

  it('concurrency 1: второй запрос стартует после конца первого', async () => {
    const { c, log } = client()
    const engine = createEdgeEngine({ client: c })
    await Promise.all([all(engine.speak('one', '', {})), all(engine.speak('two', '', {}))])
    expect(log).toEqual(['start one', 'end one', 'start two', 'end two'])
  })

  it('403 — пауза и повтор; кончились повторы — понятная ошибка; другая ошибка — без повтора', async () => {
    const waits: number[] = []
    const sleep = async (ms: number): Promise<void> => void waits.push(ms)
    const ok = client({ fail: 2 })
    await all(createEdgeEngine({ client: ok.c, sleep, backoff: [10, 20] }).speak('x', '', {}))
    expect(waits).toEqual([10, 20])
    const bad = client({ fail: 3 })
    await expect(all(createEdgeEngine({ client: bad.c, sleep, backoff: [10, 20] }).speak('x', '', {}))).rejects.toThrow(/режет запросы с этого IP \(403\)/)
    const other = client({ fail: 1, blocked: false })
    await expect(all(createEdgeEngine({ client: other.c, sleep, backoff: [10] }).speak('x', '', {}))).rejects.toThrow(/edge\.speak: boom/)
    expect(other.log).toEqual(['start x'])
  })
})

describe('openai', () => {
  it('POST {base}/v1/audio/speech: модель, голос, формат, темп, инструкция, ключ', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const engine = createOpenAIEngine({
      baseUrl: 'http://127.0.0.1:8000/',
      apiKey: 'test-key-1',
      model: 'qwen3-tts',
      voices: ['alice', 'bob'],
      defaultVoice: 'alice',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init })
        return new Response(new Uint8Array([1, 2, 3, 4]))
      }) as typeof fetch,
    })
    const [c] = await all(engine.speak('hi', '', { speed: 1.5, instruct: 'softly' }))
    expect(seen[0]!.url).toBe('http://127.0.0.1:8000/v1/audio/speech')
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer test-key-1')
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ model: 'qwen3-tts', input: 'hi', voice: 'alice', response_format: 'pcm', speed: 1.5, instructions: 'softly' })
    expect(c!.mime).toBe('audio/l16; rate=24000; channels=1')
    expect((await engine.voices()).map((v) => v.id)).toEqual(['alice', 'bob'])
    expect(openaiRoot('http://h/v1')).toBe('http://h/v1')
  })

  it('звук потоком (llm-gate): куски по мере прихода, PCM — по чётной границе', async () => {
    const parts = [[1, 2, 3], [4, 5], [6]]
    const body = () => new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close() } })
    const engine = createOpenAIEngine({ baseUrl: 'http://h', model: 'm', fetch: (async () => new Response(body())) as typeof fetch })
    const pcm = await all(engine.speak('x', 'v', {}))
    expect(pcm.map((c) => [...c.data])).toEqual([[1, 2], [3, 4], [5, 6]])
    const mp3 = await all(engine.speak('x', 'v', { format: 'mp3' }))
    expect(mp3.map((c) => [...c.data])).toEqual(parts)
    const empty = createOpenAIEngine({ baseUrl: 'http://h', model: 'm', fetch: (async () => new Response(new Uint8Array())) as typeof fetch })
    await expect(all(empty.speak('x', 'v', {}))).rejects.toThrow(/пустой ответ/)
  })

  it('ошибка — статус и тело; без голоса — ошибка до запроса', async () => {
    const engine = createOpenAIEngine({ baseUrl: 'http://h', model: 'm', fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch })
    await expect(all(engine.speak('x', 'v', {}))).rejects.toThrow(/HTTP 500 — nope/)
    await expect(all(engine.speak('x', '', {}))).rejects.toThrow(/не задан голос/)
  })
})
