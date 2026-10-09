import { describe, expect, it } from 'vitest'
import { alignWords, createGeminiTranscriber, createVertexTranscriber, guessLanguage, mergeVocabulary, parseInteraction, parseVertex, segmentsOf, sniffAudio, speakerLabel, transcribeBody, vertexTranscribeBody } from '../src/index.js'
import { createListener, ffprobeOf, listenModelOf, listenerFromCtx, parseListenModel, truncatedAt } from '../src/node/index.js'
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

  it('слитные реплики диаризации — пробел после конца предложения', () => {
    expect(parseInteraction(interaction('Дальше L1 и стриминг.Всё верно!Да')).text).toBe('Дальше L1 и стриминг. Всё верно! Да')
    expect(parseInteraction(interaction('версия 3.5 и v2.Ok, Node.JS')).text).toBe('версия 3.5 и v2. Ok, Node.JS')
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

  it('сегменты без словаря — один запрос с таймстемпами и диаризацией', async () => {
    let calls = 0
    const engine = createGeminiTranscriber({ apiKey: 'k', fetch: (async () => (calls++, json(interaction('Да. Нет.', [word('Да.', 0, 0.5, 'spk:0'), word('Нет.', 0.6, 1, 'spk:1')])))) as unknown as typeof fetch })
    const t = await engine.transcribe({ data: new Uint8Array(1), mime: 'audio/mp3' }, { diarize: true })
    expect(calls).toBe(1)
    expect(t.vocabulary).toBe(0)
    expect(t.segments).toEqual([
      { start: 0, end: 0.5, text: 'Да.', speaker: 'A' },
      { start: 0.6, end: 1, text: 'Нет.', speaker: 'B' },
    ])
  })

  it('сегменты со словарём — два прохода разом: текст со словарём, время и спикеры — выравниванием', async () => {
    const bodies: Record<string, unknown>[] = []
    const engine = createGeminiTranscriber({
      apiKey: 'k',
      fetch: (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body)) as { generation_config?: { transcription_config?: Record<string, unknown> } }
        bodies.push(b)
        return b.generation_config?.transcription_config?.custom_vocabulary
          ? json(interaction('Запусти runz Projektor. Sulafat читает.'))
          : json(interaction('Запусти ранс-проектор. Сулафат читает.', [word('Запусти', 0, 0.5, 'spk:0'), word('ранс-проектор.', 0.5, 1.5, 'spk:0'), word('Сулафат', 2, 2.5, 'spk:1'), word('читает.', 2.5, 3, 'spk:1')]))
      }) as typeof fetch,
    })
    const t = await engine.transcribe({ data: new Uint8Array(1), mime: 'audio/mp3' }, { diarize: true, vocabulary: ['runz', 'Projektor', 'Sulafat'] })
    expect(bodies).toHaveLength(2)
    expect(t.text).toBe('Запусти runz Projektor. Sulafat читает.')
    expect(t.vocabulary).toBe(3)
    expect(t.segments).toEqual([
      { start: 0, end: 1.5, text: 'Запусти runz Projektor.', speaker: 'A' },
      { start: 2, end: 3, text: 'Sulafat читает.', speaker: 'B' },
    ])
  })

  it('выравнивание: совпадения и замены берут время пары, лишние слова — между соседями', () => {
    const timed = [
      { text: 'один', start: 0, end: 1, speaker: 'A' },
      { text: 'два', start: 1, end: 2, speaker: 'A' },
      { text: 'три', start: 3, end: 4, speaker: 'B' },
    ]
    expect(alignWords('Один, полтора два три', timed)).toEqual([
      { text: 'Один,', start: 0, end: 1, speaker: 'A' },
      { text: 'полтора', start: 1, end: 1, speaker: 'A' },
      { text: 'два', start: 1, end: 2, speaker: 'A' },
      { text: 'три', start: 3, end: 4, speaker: 'B' },
    ])
    expect(alignWords('', timed)).toEqual([])
    expect(alignWords('x', [])).toEqual([{ text: 'x', start: 0, end: 0 }])
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
  it('модель: studio:/vertex: → движок и имя, голое — studio, пусто — по умолчанию, чужой движок — ошибка', () => {
    expect(listenModelOf('studio:gemini-3.5-transcribe')).toBe('gemini-3.5-transcribe')
    expect(listenModelOf(undefined)).toBe('gemini-3.5-transcribe')
    expect(listenModelOf('x-model')).toBe('x-model')
    expect(parseListenModel('vertex:gemini-3.5-transcribe')).toEqual({ engine: 'vertex', model: 'gemini-3.5-transcribe' })
    expect(parseListenModel('vertex:')).toEqual({ engine: 'vertex', model: 'gemini-3.5-transcribe-preview' })
    expect(() => listenModelOf('openai:whisper-1')).toThrow(/не поддержан/)
  })

  it('из конфига: vertex: — проект провайдера vertex, токен; без проекта — ошибка', () => {
    const l = listenerFromCtx(fakeCtx({ provider: { vertex: { type: 'vertex', project: 'p1' } } }), { model: 'vertex:gemini-3.5-transcribe-preview', token: async () => 't' })
    expect(l.model).toBe('vertex:gemini-3.5-transcribe-preview')
    expect(() => listenerFromCtx(fakeCtx({}), { model: 'vertex:x' })).toThrow(/нет Vertex/)
  })

  it('vertex: inline-потолок — 413 без Files API', async () => {
    const l = listenerFromCtx(fakeCtx({ provider: { vertex: { type: 'vertex', project: 'p1' } } }), { model: 'vertex:', token: async () => 't', inlineMax: 4, fetch: (async () => json({})) as typeof fetch })
    await expect(l.transcribe(bytes('ID3', 64))).rejects.toMatchObject({ status: 413 })
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

  it('обрыв ответа с таймстемпами: последнее слово сильно раньше конца звука — повтор, лучший из двух; не помог — truncated', async () => {
    expect(truncatedAt({ text: '', model: 'm', vocabulary: 0, words: [{ text: 'x', start: 0, end: 199 }] }, 304)).toBe(true)
    expect(truncatedAt({ text: '', model: 'm', vocabulary: 0, words: [{ text: 'x', start: 0, end: 295 }] }, 304)).toBe(false)
    expect(truncatedAt({ text: '', model: 'm', vocabulary: 0 }, 304)).toBe(false)
    const ends = [199, 303]
    let calls = 0
    const fetchMock = (async () => json(interaction('Слово.', [word('Слово.', 0, ends[calls++] ?? 100, 'spk:0')]))) as unknown as typeof fetch
    const l = createListener({ apiKey: 'k', fetch: fetchMock, duration: async () => 304 })
    const t = await l.transcribe(bytes('ID3\x04'), { diarize: true })
    expect(calls).toBe(2)
    expect(t).toMatchObject({ attempts: 2, duration: 304 })
    expect(t.truncated).toBeUndefined()
    expect(t.segments?.[0]?.end).toBe(303)
    calls = 0
    ends.splice(0, 2, 150, 120)
    const bad = await l.transcribe(bytes('ID3\x04'), { diarize: true })
    expect(bad).toMatchObject({ attempts: 2, truncated: true })
    expect(bad.segments?.[0]?.end).toBe(150)
  })
})

describe('stt: vertex', () => {
  const vresp = (parts: unknown[]) => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] })
  const vword = (word: string, s: number, e: number) => ({ word, startOffset: `${s}s`, endOffset: `${e}s` })

  it('тело: inlineData, languageCodes, customVocabulary; сегменты — wordTimestamp/diarization без словаря; uri — 413', () => {
    expect(vertexTranscribeBody({ data: new TextEncoder().encode('AUDIO'), mime: 'audio/mp3' }, { language: 'ru', vocabulary: ['runz'] })).toEqual({
      contents: [{ role: 'user', parts: [{ inlineData: { data: 'QVVESU8=', mimeType: 'audio/mp3' } }] }],
      generationConfig: { audioTranscriptionConfig: { languageCodes: ['ru'], customVocabulary: ['runz'] } },
    })
    const d = vertexTranscribeBody({ data: new Uint8Array(1), mime: 'audio/wav' }, { diarize: true, vocabulary: ['runz'] })
    expect(d.generationConfig).toEqual({ audioTranscriptionConfig: { wordTimestamp: true, diarization: true } })
    expect(() => vertexTranscribeBody({ uri: 'https://x', mime: 'audio/mp3' })).toThrow(/inline/)
  })

  it('ответ: реплики по частям, speakerLabel → A/B, слова со временем', () => {
    const r = parseVertex(vresp([
      { text: 'Привет.', audioTranscription: { text: 'Привет.', speakerLabel: 'spk:0', words: [vword('Привет.', 0.2, 1)] } },
      { text: 'Да.', audioTranscription: { text: 'Да.', speakerLabel: 'spk:1', words: [vword('Да.', 1.5, 1.8)] } },
    ]))
    expect(r.text).toBe('Привет.\nДа.')
    expect(r.words).toEqual([
      { text: 'Привет.', start: 0.2, end: 1, speaker: 'A' },
      { text: 'Да.', start: 1.5, end: 1.8, speaker: 'B' },
    ])
    expect(parseVertex(vresp([{ text: 'Только текст' }]))).toEqual({ text: 'Только текст', words: [] })
  })

  it('запрос: URL global, Bearer и x-goog-user-project; 401 — свежий токен; 429 — повтор', async () => {
    const calls: { url: string; auth: string; project: string }[] = []
    let n = 0
    const tokens = ['old', 'new']
    const fetchMock = (async (url: string, init: RequestInit = {}) => {
      const h = init.headers as Record<string, string>
      calls.push({ url, auth: h.authorization!, project: h['x-goog-user-project']! })
      n++
      if (n === 1) return new Response('{}', { status: 401 })
      if (n === 2) return json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } }, 429)
      return json(vresp([{ text: 'Готово', audioTranscription: { text: 'Готово' } }]))
    }) as typeof fetch
    const stt = createVertexTranscriber({ project: 'p1', token: async () => tokens.shift()!, fetch: fetchMock, sleep: async () => {} })
    const t = await stt.transcribe({ data: new Uint8Array([1]), mime: 'audio/mp3' }, { vocabulary: ['runz'] })
    expect(t).toMatchObject({ text: 'Готово', model: 'gemini-3.5-transcribe-preview', vocabulary: 1 })
    expect(calls[0]!.url).toBe('https://aiplatform.googleapis.com/v1beta1/projects/p1/locations/global/publishers/google/models/gemini-3.5-transcribe-preview:generateContent')
    expect(calls.map((c) => c.auth)).toEqual(['Bearer old', 'Bearer new', 'Bearer new'])
    expect(calls[0]!.project).toBe('p1')
  })

  it('ошибка провайдера — со статусом; 429 сверх повторов — 429', async () => {
    const e404 = createVertexTranscriber({ project: 'p', token: async () => 't', fetch: (async () => json({ error: { code: 404, message: 'not found' } }, 404)) as typeof fetch })
    await expect(e404.transcribe({ data: new Uint8Array([1]), mime: 'audio/mp3' })).rejects.toMatchObject({ status: 404 })
    const e429 = createVertexTranscriber({ project: 'p', token: async () => 't', retries: 1, sleep: async () => {}, fetch: (async () => json({ error: { message: 'exhausted' } }, 429)) as typeof fetch })
    await expect(e429.transcribe({ data: new Uint8Array([1]), mime: 'audio/mp3' })).rejects.toMatchObject({ status: 429 })
  })

  it('словарь с диаризацией — два прохода, как у Studio', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = (async (_url: string, init: RequestInit = {}) => {
      const b = JSON.parse(String(init.body)) as { generationConfig?: { audioTranscriptionConfig?: { diarization?: boolean } } }
      bodies.push(b)
      return b.generationConfig?.audioTranscriptionConfig?.diarization
        ? json(vresp([{ text: 'Привет Сулафат', audioTranscription: { text: 'Привет Сулафат', speakerLabel: 'spk:0', words: [vword('Привет', 0, 0.5), vword('Сулафат', 0.6, 1.2)] } }]))
        : json(vresp([{ text: 'Привет Sulafat', audioTranscription: { text: 'Привет Sulafat' } }]))
    }) as typeof fetch
    const stt = createVertexTranscriber({ project: 'p', token: async () => 't', fetch: fetchMock })
    const t = await stt.transcribe({ data: new Uint8Array([1]), mime: 'audio/mp3' }, { diarize: true, vocabulary: ['Sulafat'] })
    expect(bodies).toHaveLength(2)
    expect(t.text).toBe('Привет Sulafat')
    expect(t.segments).toEqual([{ start: 0, end: 1.2, text: 'Привет Sulafat', speaker: 'A' }])
  })
})
