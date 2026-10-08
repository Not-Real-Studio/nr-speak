import { describe, expect, it } from 'vitest'
import { createSpeaker, parseWav, streamAll } from '../src/index.js'
import type { SegmentCache } from '../src/index.js'
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

  it('один кусок разом дважды — один синтез', async () => {
    const v = mockEngine({ kind: 'vertex' })
    const s = createSpeaker({ engines: { vertex: v.engine }, defaultVoice: 'vertex:Kore' })
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
    await new Promise((r) => setTimeout(r, 5))
    expect(v.calls.map((c) => c.text)).toEqual(['один', 'два'])
    const rest: string[] = []
    for await (const p of gen) rest.push(dec(p))
    expect(rest).toEqual(['[Kore:два]', '[Kore:три]'])
    const wav = await streamAll(s.stream(['а', 'б'], {}, 'wav'))
    expect(dec(parseWav(wav).pcm)).toBe('[Kore:а][Kore:б]')
  })
})
