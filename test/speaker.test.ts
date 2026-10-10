import { describe, expect, it } from 'vitest'
import { createSpeaker, parseWav, streamAll } from '../src/index.js'
import type { AudioChunk, FfmpegPipe, SegmentCache, TtsEngine } from '../src/index.js'
import { mockEngine } from './helpers.js'

function memCache(): SegmentCache & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>()
  return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) }
}

const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('speaker', () => {
  it('кусок: голос по умолчанию, кэш — второй раз без синтеза; ключ зависит от темпа и голоса', async () => {
    const v = mockEngine({ kind: 'vertex', voices: ['Kore'] })
    const cache = memCache()
    const s = createSpeaker({ engines: { vertex: v.engine }, defaultVoice: 'vertex:Kore', cache })
    const a = await s.synth('Привет', {}, 'pcm')
    expect(a.cached).toBe(false)
    expect(dec(a.data)).toBe('[Kore:Привет]')
    expect(a.voice).toEqual({ engine: 'vertex', voice: 'Kore' })
    const b = await s.synth('Привет', { voice: 'Kore' }, 'pcm')
    expect(b.cached).toBe(true)
    expect(s.stats).toEqual({ synth: 1, hits: 1 })
    expect(v.calls.length).toBe(1)
    expect(a.key).toMatch(/^[0-9a-f]{64}\.pcm$/)
    expect((await s.key('Привет', { speed: 1.1 }, 'pcm')).key).not.toBe(a.key)
    expect((await s.key('Привет', { voice: 'Puck' }, 'pcm')).key).not.toBe(a.key)
    expect((await s.key('Привет', {}, 'mp3')).key).not.toBe(a.key)
  })

  it('один кусок разом дважды — один синтез (идущий — общий, готовый — из кэша)', async () => {
    const v = mockEngine({ kind: 'vertex' })
    const slow = v.engine.speak
    v.engine.speak = async function* (...a) {
      await new Promise((r) => setTimeout(r, 20))
      yield* slow(...a)
    }
    const s = createSpeaker({ engines: { vertex: v.engine }, defaultVoice: 'vertex:Kore', cache: memCache() })
    const [a, b] = await Promise.all([s.synth('x', {}, 'pcm'), s.synth('x', {}, 'pcm')])
    expect(dec(a.data)).toBe(dec(b.data))
    expect(v.calls.length).toBe(1)
  })

  it('темп: свой у движка — в speak; иначе — atempo в ffmpeg; mp3-хинт движку', async () => {
    const edge = mockEngine({ kind: 'edge', voices: ['ru-RU-SvetlanaNeural'], nativeSpeed: true, mime: 'audio/mpeg' })
    const vertex = mockEngine({ kind: 'vertex' })
    const args: string[][] = []
    const s = createSpeaker({
      engines: { edge: edge.engine, vertex: vertex.engine },
      ffmpeg: async (a) => {
        args.push(a)
        return new Uint8Array([1])
      },
    })
    const r = await s.synth('x', { voice: 'Svetlana', speed: 1.5 }, 'mp3')
    expect(edge.calls[0]!.opts).toEqual({ speed: 1.5, format: 'mp3' })
    expect(dec(r.data)).toBe('[ru-RU-SvetlanaNeural:x]')
    expect(args).toEqual([])
    await s.synth('x', { voice: 'vertex:Kore', speed: 1.5 }, 'mp3')
    expect(vertex.calls[0]!.opts).toEqual({ format: 'mp3' })
    expect(args[0]).toContain('atempo=1.5')
    await expect(s.synth('x', { voice: 'Kore', speed: 9 }, 'mp3')).rejects.toThrow(/темп 9 вне/)
    await expect(s.synth('  ', {}, 'mp3')).rejects.toThrow(/пустой текст/)
  })

  it('поток: куски по порядку, следующий синтезируется заранее; wav — один заголовок', async () => {
    const v = mockEngine({ kind: 'vertex' })
    const s = createSpeaker({ engines: { vertex: v.engine }, defaultVoice: 'vertex:Kore' })
    const gen = s.stream(['один', 'два', 'три'], {}, 'pcm')
    const first = await gen.next()
    expect(dec(first.value as Uint8Array)).toBe('[Kore:один]')
    // Следующий кусок — заранее (до чтения потока дальше): ждём условием, не таймером.
    for (let i = 0; i < 100 && v.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
    expect(v.calls.map((c) => c.text)).toEqual(['один', 'два'])
    const rest: string[] = []
    for await (const p of gen) rest.push(dec(p))
    expect(rest).toEqual(['[Kore:два]', '[Kore:три]'])
    const wav = await streamAll(s.stream(['а', 'б'], {}, 'wav'))
    expect(dec(parseWav(wav).pcm)).toBe('[Kore:а][Kore:б]')
  })

  it('поток куска (DEV-250 §6): кадры движка → ffmpeg-труба → наружу до конца синтеза; кэш — по завершении', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const calls: string[] = []
    const engine: TtsEngine = {
      kind: 'vertex',
      async voices() {
        return []
      },
      async design() {
        throw new Error('нет')
      },
      async *speak(text): AsyncGenerator<AudioChunk> {
        calls.push(text)
        const mime = 'audio/l16; rate=24000; channels=1'
        yield { data: new TextEncoder().encode(`<${text}:1>`), mime }
        await gate
        yield { data: new TextEncoder().encode(`<${text}:2>`), mime }
      },
    }
    const pipes: string[][] = []
    // Труба-мок: «кодирует» каждый кадр сразу (верхний регистр), выход — по мере записи.
    const ffmpegPipe: FfmpegPipe = (args) => {
      pipes.push(args)
      const queue: Uint8Array[] = []
      let wake: () => void = () => {}
      let ended = false
      return {
        async write(d) {
          queue.push(new TextEncoder().encode(dec(d).toUpperCase()))
          wake()
        },
        end() {
          ended = true
          wake()
        },
        kill() {
          ended = true
          wake()
        },
        output: (async function* () {
          for (;;) {
            if (queue.length) yield queue.shift()!
            else if (ended) return
            else await new Promise<void>((r) => (wake = r))
          }
        })(),
      }
    }
    const cache = memCache()
    const s = createSpeaker({ engines: { vertex: engine }, defaultVoice: 'vertex:Kore', cache, ffmpegPipe })
    const gen = s.stream(['один'], {}, 'mp3')
    const a = await gen.next()
    // Первый кадр уже снаружи, а движок ещё не закончил — кэш пуст.
    expect(dec(a.value as Uint8Array)).toBe('<ОДИН:1>')
    expect(cache.map.size).toBe(0)
    expect(pipes[0]).toContain('-flush_packets')
    release()
    const rest: string[] = []
    for await (const p of gen) rest.push(dec(p))
    expect(rest).toEqual(['<ОДИН:2>'])
    expect([...cache.map.values()].map(dec)).toEqual(['<ОДИН:1><ОДИН:2>'])
    // Повтор — из кэша, без движка.
    expect(dec(await streamAll(s.stream(['один'], {}, 'mp3')))).toBe('<ОДИН:1><ОДИН:2>')
    expect(calls).toEqual(['один'])
  })

  it('поток куска: клиент ушёл посреди — ffmpeg оборван, в кэш не пишется; ошибка движка — до первого байта', async () => {
    const v = mockEngine({ kind: 'vertex', fail: Object.assign(new Error('лимит'), { status: 429 }) })
    const s = createSpeaker({ engines: { vertex: v.engine }, defaultVoice: 'vertex:Kore', cache: memCache() })
    await expect(s.stream(['x'], {}, 'mp3').next()).rejects.toThrow('лимит')
    let killed = false
    const engine: TtsEngine = {
      kind: 'vertex',
      async voices() {
        return []
      },
      async design() {
        throw new Error('нет')
      },
      async *speak(): AsyncGenerator<AudioChunk> {
        for (let i = 0; i < 100; i++) yield { data: new Uint8Array([i]), mime: 'audio/l16; rate=24000; channels=1' }
      },
    }
    const ffmpegPipe: FfmpegPipe = () => {
      const q: Uint8Array[] = []
      return {
        async write(d) {
          q.push(d)
        },
        end() {},
        kill() {
          killed = true
        },
        output: (async function* () {
          for (;;) {
            if (killed) return
            if (q.length) yield q.shift()!
            else await new Promise((r) => setTimeout(r, 1))
          }
        })(),
      }
    }
    const cache = memCache()
    const s2 = createSpeaker({ engines: { vertex: engine }, defaultVoice: 'vertex:Kore', cache, ffmpegPipe })
    const gen = s2.stream(['y'], {}, 'mp3')
    await gen.next()
    await gen.return(undefined)
    expect(killed).toBe(true)
    expect(cache.map.size).toBe(0)
  })

  it('поток куска: mp3 движка (Edge) — без ffmpeg, кадры как есть', async () => {
    const edge = mockEngine({ kind: 'edge', voices: ['ru-RU-SvetlanaNeural'], nativeSpeed: true, mime: 'audio/mpeg' })
    const s = createSpeaker({ engines: { edge: edge.engine }, ffmpegPipe: () => {
      throw new Error('ffmpeg не нужен')
    } })
    expect(dec(await streamAll(s.stream(['x'], { voice: 'Svetlana' }, 'mp3')))).toBe('[ru-RU-SvetlanaNeural:x]')
  })
})
