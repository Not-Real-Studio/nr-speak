import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanWav, createGeminiEngine, createRoutedEngine, createSpeaker, createVertexEngine, filterLibrary, matchLibrary, resolveVoice, voiceConfig, wavHeader } from '../src/index.js'
import { entryOf, fileCollection, fileLibraryCache, slugOf } from '../src/node/index.js'
import { json, mockEngine } from './helpers.js'

const LIB = [
  { id: 'en-us-podcaster-1', type: 'prebuilt', display_name: 'Podcaster 1', gender: 'male', language_code: 'en-US', pitch: 'low', persona: 'Radio Host', description: 'deep, velvety' },
  { id: 'ja-jp-neno', type: 'prebuilt', display_name: 'Neno', gender: 'female', language_code: 'ja-JP', description: 'soft' },
  { id: 'ko-kr-neno', type: 'prebuilt', display_name: 'Neno', gender: 'female', language_code: 'ko-KR' },
  { id: 'achernar', type: 'prebuilt', display_name: 'Achernar', gender: 'female', language_code: 'en-US' },
]

/** fetch AI Studio: список голосов (страницами), свои — отдельно; пишет запросы. */
function studioFetch(own: unknown[] = [{ id: 'voice_abc', type: 'prompted' }]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const http = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) })
    if (url.includes('/v1beta/voices?')) {
      const pre = url.includes('type=prebuilt')
      if (!url.includes('pageToken')) return json({ voices: pre ? LIB.slice(0, 2) : [...own, ...LIB.slice(0, 2)], next_page_token: 'p2' })
      return json({ voices: LIB.slice(2) })
    }
    if (url.endsWith('/v1beta/voices') && init?.method === 'POST') return json({ id: 'voice_new' })
    if (init?.method === 'DELETE') return new Response('{}', { status: 200 })
    return json({ error: { message: 'unexpected' } }, 500)
  }) as typeof fetch
  return { http, calls }
}

describe('библиотека AI Studio', () => {
  it('list с type=prebuilt, все страницы, поля библиотеки; кэш — второй раз без сети', async () => {
    const { http, calls } = studioFetch()
    let stored: unknown
    const engine = createGeminiEngine({ apiKey: 'k', cache: { get: () => undefined, set() {} }, fetch: http, libraryCache: { get: async () => stored as never, set: async (l) => void (stored = l) } })
    const lib = await engine.library!()
    expect(lib.map((v) => v.id)).toEqual(LIB.map((v) => v.id))
    expect(lib[0]).toMatchObject({ name: 'Podcaster 1', pitch: 'low', persona: 'Radio Host', description: 'deep, velvety', lang: 'en-US' })
    expect(calls.every((c) => c.url.includes('type=prebuilt'))).toBe(true)
    const n = calls.length
    await engine.library!()
    expect(calls.length).toBe(n)
    await engine.library!({ fresh: true })
    expect(calls.length).toBe(n + 2)
  })

  it('кэш на файле живёт сутки', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'speak-lib-'))
    let t = 1000
    const c = fileLibraryCache(join(dir, 'lib.json'), 24 * 3600_000, () => t)
    expect(await c.get()).toBeUndefined()
    await c.set([{ id: 'a' }])
    expect(await c.get()).toEqual([{ id: 'a' }])
    t += 24 * 3600_000
    expect(await c.get()).toBeUndefined()
  })

  it('резолв studio:<id> и имени (язык — если неоднозначно), без префикса — тоже', async () => {
    const { http } = studioFetch()
    const studio = createGeminiEngine({ apiKey: 'k', cache: { get: () => undefined, set() {} }, fetch: http })
    const e = { studio, vertex: mockEngine({ kind: 'vertex', voices: ['Kore'] }).engine }
    expect(await resolveVoice(e, 'studio:en-us-podcaster-1')).toEqual({ engine: 'studio', voice: 'en-us-podcaster-1' })
    expect(await resolveVoice(e, 'studio:Podcaster 1')).toEqual({ engine: 'studio', voice: 'en-us-podcaster-1' })
    expect(await resolveVoice(e, 'studio:Neno (ja-JP)')).toEqual({ engine: 'studio', voice: 'ja-jp-neno' })
    expect(await resolveVoice(e, 'studio:ko-KR/Neno')).toEqual({ engine: 'studio', voice: 'ko-kr-neno' })
    await expect(resolveVoice(e, 'studio:Neno')).rejects.toThrow(/нескольких языках.*ja-JP.*ko-KR/)
    expect(await resolveVoice(e, 'studio:voice_xyz')).toEqual({ engine: 'studio', voice: 'voice_xyz' })
    expect(await resolveVoice(e, 'studio:Kore')).toEqual({ engine: 'studio', voice: 'Kore' })
    expect(await resolveVoice(e, 'Podcaster 1')).toEqual({ engine: 'studio', voice: 'en-us-podcaster-1' })
  })

  it('фильтр: пол, язык префиксом, подстрока', () => {
    const lib = LIB.map((v) => ({ id: v.id, name: v.display_name, gender: v.gender, lang: v.language_code, ...(v.description ? { description: v.description } : {}) }))
    expect(filterLibrary(lib, { lang: 'ja' }).map((v) => v.id)).toEqual(['ja-jp-neno'])
    expect(filterLibrary(lib, { gender: 'male' }).map((v) => v.id)).toEqual(['en-us-podcaster-1'])
    expect(filterLibrary(lib, { q: 'velvet' }).map((v) => v.id)).toEqual(['en-us-podcaster-1'])
    expect(matchLibrary(lib, 'ACHERNAR')?.id).toBe('achernar')
  })

  it('синтез: студийный — prebuiltVoiceConfig, библиотечный и свой — voice; Vertex библиотеку не знает', async () => {
    expect(voiceConfig('Kore')).toEqual({ prebuiltVoiceConfig: { voiceName: 'Kore' } })
    expect(voiceConfig('charon')).toEqual({ prebuiltVoiceConfig: { voiceName: 'Charon' } })
    expect(voiceConfig('en-us-neno')).toEqual({ voice: 'en-us-neno' })
    expect(voiceConfig('voice_abc')).toEqual({ voice: 'voice_abc' })
    const vertex = createVertexEngine({ project: 'p', token: async () => 't', fetch: (async () => json({})) as typeof fetch })
    await expect(async () => {
      for await (const _ of vertex.speak('x', 'en-us-neno', {})) void _
    }).rejects.toThrow(/из библиотеки AI Studio, Vertex его не знает: studio:en-us-neno/)
    // Маршрут: библиотечный — в AI Studio, студийный — в Vertex.
    const s = mockEngine({ kind: 'gemini' })
    const v = mockEngine({ kind: 'vertex' })
    const routed = createRoutedEngine(s.engine, v.engine)
    for await (const _ of routed.speak('a', 'en-us-neno', {})) void _
    for await (const _ of routed.speak('b', 'Kore', {})) void _
    expect(s.calls.map((c) => c.voice)).toEqual(['en-us-neno'])
    expect(v.calls.map((c) => c.voice)).toEqual(['Kore'])
  })
})

describe('клон и удаление', () => {
  it('replicate: store, replicated, модель, честный заголовок WAV из стримового', async () => {
    const { http, calls } = studioFetch()
    const engine = createGeminiEngine({ apiKey: 'k', cache: { get: () => undefined, set() {} }, fetch: http })
    const pcm = new Uint8Array(4800).fill(7)
    const streamWav = new Uint8Array([...wavHeader(24000), ...pcm])
    const r = await engine.replicate!({ name: 'Денис', source: streamWav, consent: pcm, lang: 'ru-RU' })
    expect(r).toEqual({ id: 'voice_new' })
    const body = JSON.parse(String(calls.at(-1)!.init!.body)) as { store: boolean; voice: Record<string, unknown> & { replicated: { source_audio: { data: string; mime_type: string }; consent_audio: { data: string } } } }
    expect(body.store).toBe(true)
    expect(body.voice).toMatchObject({ type: 'replicated', model: 'gemini-3.8-flash-tts', display_name: 'Денис', language_code: 'ru-RU' })
    const src = Buffer.from(body.voice.replicated.source_audio.data, 'base64')
    expect(body.voice.replicated.source_audio.mime_type).toBe('audio/wav')
    expect(src.readUInt32LE(4)).toBe(36 + 4800)
    expect(src.readUInt32LE(40)).toBe(4800)
    // Сырой PCM — тоже в WAV с заголовком.
    const consent = Buffer.from(body.voice.replicated.consent_audio.data, 'base64')
    expect(consent.subarray(0, 4).toString()).toBe('RIFF')
    expect(cleanWav(pcm).length).toBe(44 + 4800)
  })

  it('ошибка согласия — человеческим текстом', async () => {
    const http = (async () => json({ error: { message: 'Consent audio does not match' } }, 400)) as unknown as typeof fetch
    const engine = createGeminiEngine({ apiKey: 'k', cache: { get: () => undefined, set() {} }, fetch: http })
    await expect(engine.replicate!({ name: 'x', source: new Uint8Array(10), consent: new Uint8Array(10) })).rejects.toThrow(/согласие не распознано/)
  })

  it('remove — DELETE своего, чужой id — ошибка', async () => {
    const { http, calls } = studioFetch()
    const engine = createGeminiEngine({ apiKey: 'k', cache: { get: () => undefined, set() {} }, fetch: http })
    await engine.remove!('voice_abc')
    expect(calls.at(-1)).toMatchObject({ url: 'https://generativelanguage.googleapis.com/v1beta/voices/voice_abc', init: { method: 'DELETE' } })
    await expect(engine.remove!('en-us-neno')).rejects.toThrow(/не свой голос/)
  })
})

describe('коллекция @slug', () => {
  const PODCASTER = `$name: Подкастер, 60
$description: Библиотека Google
$engine: studio
$voice: en-us-podcaster-1
$type: prebuilt
$lang: en-US
$gender: male
$sample_style: ~/x.wav
$// комментарий Denis
$style: deep, unhurried
$tags: $[narrator, low]
`

  it('разбор файла: поля, список, прочее в extra', () => {
    const e = entryOf('podcaster-1', PODCASTER)!
    expect(e).toMatchObject({ slug: 'podcaster-1', engine: 'studio', voice: 'en-us-podcaster-1', name: 'Подкастер, 60', style: 'deep, unhurried', tags: ['narrator', 'low'] })
    expect(e.extra).toEqual({ sample_style: '~/x.wav' })
    expect(entryOf('x', '$name: без голоса')).toBeUndefined()
    expect(slugOf('Денис, шёпот')).toBe('denis-shepot')
  })

  it('Speaker: @slug → движок и голос коллекции, $style — подача по умолчанию, своя — главнее', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'speak-col-'))
    writeFileSync(join(dir, 'podcaster-1.mdz'), PODCASTER)
    const studio = mockEngine({ kind: 'gemini' })
    const speaker = createSpeaker({ engines: { studio: studio.engine }, collection: fileCollection(dir) })
    expect(await speaker.resolve('@podcaster-1')).toEqual({ engine: 'studio', voice: 'en-us-podcaster-1' })
    await speaker.synth('Привет', { voice: '@podcaster-1' }, 'pcm')
    await speaker.synth('Привет', { voice: '@podcaster-1', instruct: 'шёпотом' }, 'pcm')
    expect(studio.calls.map((c) => c.opts.instruct)).toEqual(['deep, unhurried', 'шёпотом'])
    await expect(speaker.resolve('@nobody')).rejects.toThrow(/в коллекции нет голоса «nobody»/)
    const bare = createSpeaker({ engines: { studio: studio.engine } })
    await expect(bare.resolve('@podcaster-1')).rejects.toThrow(/коллекция не подключена/)
  })

  it('save / update / remove: комментарии живут, занятый слаг — с номером', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'speak-col-'))
    writeFileSync(join(dir, 'podcaster-1.mdz'), PODCASTER)
    const col = fileCollection(dir)
    const e = await col.save({ name: 'Подкастер 1', slug: 'podcaster-1', engine: 'studio', voice: 'ja-jp-neno', tags: ['ja'] })
    expect(e.slug).toBe('podcaster-1-2')
    await col.update('podcaster-1', { note: 'нравится\nочень', tags: ['a', 'b'], style: '' })
    const text = readFileSync(join(dir, 'podcaster-1.mdz'), 'utf8')
    expect(text).toContain('$// комментарий Denis')
    expect(text).toContain('$note: нравится очень')
    expect(text).toContain('$tags: $[a, b]')
    expect(text).not.toContain('$style')
    expect((await col.find('studio', 'ja-jp-neno'))?.slug).toBe('podcaster-1-2')
    expect((await col.list()).map((x) => x.slug)).toEqual(['podcaster-1', 'podcaster-1-2'])
    expect(await col.remove('podcaster-1-2')).toBe(true)
    await expect(col.get('../x')).rejects.toThrow(/слаг/)
  })
})
