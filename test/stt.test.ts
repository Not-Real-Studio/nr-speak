import { describe, expect, it } from 'vitest'
import { createGeminiTranscriber, guessLanguage, mergeVocabulary, parseInteraction, segmentsOf, sniffAudio, speakerLabel, transcribeBody } from '../src/index.js'
import { createListener, ffprobeOf, listenModelOf, listenerFromCtx } from '../src/node/index.js'
import { fakeCtx, json } from './helpers.js'

const bytes = (s: string, pad = 16): Uint8Array => {
  const b = new Uint8Array(Math.max(s.length, pad))
  b.set([...s].map((c) => c.charCodeAt(0)))
  return b
}

const word = (text: string, start: number, end: number, speaker?: string) => ({ type: 'word_info', text, start_offset: `${start}s`, end_offset: `${end}s`, ...(speaker ? { speaker } : {}) })
const interaction = (text: string, annotations?: unknown[]) => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text, ...(annotations ? { annotations } : {}) }] }] })

describe('stt: тело запроса', () => {
  it('inline: base64, mime, язык, словарь; без сегментов mode не шлётся', () => {
    const b = transcribeBody({ data: new TextEncoder().encode('AUDIO'), mime: 'audio/mp3' }, 'gemini-3.5-transcribe', { language: 'ru', vocabulary: ['runz', 'nrlib'] })
    expect(b).toEqual({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', data: 'QVVESU8=', mime_type: 'audio/mp3' }],
      generation_config: { transcription_config: { language_codes: ['ru'], custom_vocabulary: ['runz', 'nrlib'] } },
    })
  })

  it('сегменты и диаризация — таймстемпы слов, словарь не уходит (провайдер их не совмещает); uri — как есть', () => {
    const b = transcribeBody({ uri: 'https://x/files/abc', mime: 'audio/m4a' }, 'm', { diarize: true, vocabulary: ['runz'] })
    expect(b).toEqual({
      model: 'm',
      input: [{ type: 'audio', uri: 'https://x/files/abc', mime_type: 'audio/m4a' }],
      generation_config: { transcription_config: { mode: { type: 'verbatim', timestamp_granularities: ['word'], diarization_mode: 'speaker' } } },
    })
    expect(transcribeBody({ data: new Uint8Array(1), mime: 'audio/wav' }, 'm', {})).not.toHaveProperty('generation_config')
  })

  it('словарь: без дублей без регистра, пустых, порядок источников, потолок 1000', () => {
    expect(mergeVocabulary(['runz', ' nrlib '], ['RUNZ', '', 'Sulafat'], undefined, ['nrlib', 'DEV-247'])).toEqual(['runz', 'nrlib', 'Sulafat', 'DEV-247'])
    expect(mergeVocabulary(Array.from({ length: 1200 }, (_, i) => `t${i}`))).toHaveLength(1000)
  })
})

describe('stt: ответ', () => {
  it('текст и слова; спикеры spk:N → A, B; секунды из «1.300s»', () => {
    const r = parseInteraction(interaction('Привет. Да.', [word('Привет.', 0.3, 1, 'spk:0'), word('Да.', 1.5, 1.8, 'spk:1')]))
    expect(r.text).toBe('Привет. Да.')
    expect(r.words).toEqual([
      { text: 'Привет.', start: 0.3, end: 1, speaker: 'A' },
      { text: 'Да.', start: 1.5, end: 1.8, speaker: 'B' },
    ])
    expect(speakerLabel('spk:2')).toBe('C')
    expect(speakerLabel('x')).toBe('x')
  })

  it('сегменты: смена спикера, конец предложения, пауза, потолок слов', () => {
    const w = (t: string, s: number, sp?: string) => ({ text: t, start: s, end: s + 0.4, ...(sp ? { speaker: sp } : {}) })
    expect(segmentsOf([w('Раз', 0, 'A'), w('два.', 0.5, 'A'), w('Три', 1, 'A'), w('четыре', 1.5, 'B'), w('пять', 4, 'B')])).toEqual([
      { start: 0, end: 0.9, text: 'Раз два.', speaker: 'A' },
      { start: 1, end: 1.4, text: 'Три', speaker: 'A' },
      { start: 1.5, end: 1.9, text: 'четыре', speaker: 'B' },
      { start: 4, end: 4.4, text: 'пять', speaker: 'B' },
    ])
    expect(segmentsOf(Array.from({ length: 5 }, (_, i) => w(`с${i}`, i * 0.5)), { maxWords: 2 }).map((s) => s.text)).toEqual(['с0 с1', 'с2 с3', 'с4'])
  })

  it('язык по письменности', () => {
    expect(guessLanguage('Закоммить в nrlib')).toBe('ru')
    expect(guessLanguage('Deploy the worker')).toBe('en')
    expect(guessLanguage('123')).toBeUndefined()
  })
})

describe('stt: движок', () => {
  it('POST /v1beta/interactions с ключом; 429 поминутный — повтор; ответ — текст, язык, словарь', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    let n = 0
    const engine = createGeminiTranscriber({
      apiKey: 'k1',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      sleep: async () => {},
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init })
        if (n++ === 0) return json({ error: { message: 'Please retry in 1.5s' } }, 429)
        return json(interaction('Закоммить в nrlib'))
      }) as typeof fetch,
    })
    const t = await engine.transcribe({ data: new Uint8Array([1, 2]), mime: 'audio/mp3' }, { vocabulary: ['nrlib', 'runz'] })
    expect(t).toEqual({ text: 'Закоммить в nrlib', language: 'ru', model: 'gemini-3.5-transcribe', vocabulary: 2 })
    expect(seen).toHaveLength(2)
    expect(seen[1]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect((seen[1]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k1')
  })

  it('ошибка провайдера — текстом со статусом; дневной 429 — без повторов', async () => {
    const fail = createGeminiTranscriber({ apiKey: 'k', fetch: (async () => json({ error: { message: 'custom_vocabulary is incompatible with diarization.' } }, 400)) as unknown as typeof fetch })
    await expect(fail.transcribe({ data: new Uint8Array(1), mime: 'audio/mp3' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('incompatible') })
    let calls = 0
    const day = createGeminiTranscriber({ apiKey: 'k', sleep: async () => {}, fetch: (async () => (calls++, json({ error: { message: 'GenerateRequestsPerDay exceeded' } }, 429))) as unknown as typeof fetch })
    await expect(day.transcribe({ data: new Uint8Array(1), mime: 'audio/mp3' })).rejects.toMatchObject({ status: 429 })
    expect(calls).toBe(1)
  })

  it('сегменты — со словами и сегментами', async () => {
    const engine = createGeminiTranscriber({ apiKey: 'k', fetch: (async () => json(interaction('Да. Нет.', [word('Да.', 0, 0.5, 'spk:0'), word('Нет.', 0.6, 1, 'spk:1')]))) as unknown as typeof fetch })
    const t = await engine.transcribe({ data: new Uint8Array(1), mime: 'audio/mp3' }, { diarize: true, vocabulary: ['x'] })
    expect(t.vocabulary).toBe(0)
    expect(t.segments).toEqual([
      { start: 0, end: 0.5, text: 'Да.', speaker: 'A' },
      { start: 0.6, end: 1, text: 'Нет.', speaker: 'B' },
    ])
  })
})

describe('stt: формат звука', () => {
  it('сигнатуры: wav, mp3 (ID3 и кадр), ogg, flac, webm, m4a, aac; чужое — нет', () => {
    expect(sniffAudio(bytes('RIFF\0\0\0\0WAVEfmt '))).toBe('audio/wav')
    expect(sniffAudio(bytes('ID3\x04'))).toBe('audio/mp3')
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0]))).toBe('audio/mp3')
    expect(sniffAudio(new Uint8Array([0xff, 0xf1, 0x50, 0, 0, 0]))).toBe('audio/aac')
    expect(sniffAudio(bytes('OggS'))).toBe('audio/ogg')
    expect(sniffAudio(bytes('fLaC'))).toBe('audio/flac')
    expect(sniffAudio(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('audio/webm')
    expect(sniffAudio(bytes('\0\0\0\x20ftypM4A \0\0'))).toBe('audio/m4a')
    expect(sniffAudio(bytes('\0\0\0\x14ftypqt  '))).toBeUndefined()
    expect(sniffAudio(bytes('hello world'))).toBeUndefined()
  })
})

describe('stt: node', () => {
  it('модель: studio:… → имя, голое — как есть, пусто — по умолчанию, чужой движок — ошибка', () => {
    expect(listenModelOf('studio:gemini-3.5-transcribe')).toBe('gemini-3.5-transcribe')
    expect(listenModelOf(undefined)).toBe('gemini-3.5-transcribe')
    expect(listenModelOf('x-model')).toBe('x-model')
    expect(() => listenModelOf('vertex:gemini-3.5-transcribe')).toThrow(/не поддержан/)
  })

  it('ffprobe рядом с ffmpeg', () => {
    expect(ffprobeOf('/opt/homebrew/bin/ffmpeg')).toBe('/opt/homebrew/bin/ffprobe')
    expect(ffprobeOf('ffmpeg')).toBe('ffprobe')
  })

  it('из конфига: ключ провайдера google, $listen_model блока ## $speak; без ключа — ошибка', () => {
    const l = listenerFromCtx(fakeCtx({ provider: { google: { api_key: 'k' } }, speak: { listen_model: 'studio:gemini-3.5-transcribe-x' } }))
    expect(l.model).toBe('studio:gemini-3.5-transcribe-x')
    expect(() => listenerFromCtx(fakeCtx({}))).toThrow(/нет ключа AI Studio/)
  })

  it('незнакомый формат — ffmpeg в mp3; большой — Files API (загрузка, uri в запрос, удаление)', async () => {
    const seen: { url: string; method: string; body?: unknown }[] = []
    const fetchMock = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, method: init.method ?? 'GET', body: init.body })
      if (url.endsWith('/upload/v1beta/files')) return new Response('{}', { headers: { 'x-goog-upload-url': 'https://up/1' } })
      if (url === 'https://up/1') return json({ file: { name: 'files/abc', uri: 'https://g/files/abc', state: 'ACTIVE', mimeType: 'audio/mp3' } })
      if (url.endsWith('/interactions')) return json(interaction('Текст'))
      return json({})
    }) as typeof fetch
    const ffArgs: string[][] = []
    const l = createListener({ apiKey: 'k', fetch: fetchMock, inlineMax: 4, ffmpeg: async (args) => (ffArgs.push(args), bytes('ID3\x04MP3DATA')) })
    const t = await l.transcribe(bytes('????unknown'))
    expect(t).toMatchObject({ text: 'Текст', converted: true, uploaded: true })
    expect(ffArgs[0]).toContain('libmp3lame')
    const body = JSON.parse(String(seen.find((s) => s.url.endsWith('/interactions'))!.body)) as { input: unknown[] }
    expect(body.input).toEqual([{ type: 'audio', uri: 'https://g/files/abc', mime_type: 'audio/mp3' }])
    expect(seen.at(-1)).toMatchObject({ url: 'https://generativelanguage.googleapis.com/v1beta/files/abc', method: 'DELETE' })
  })
})
