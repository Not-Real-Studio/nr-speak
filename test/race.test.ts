import { describe, expect, it } from 'vitest'
import type { AudioChunk, PieceEvent, TtsEngine } from '../src/index.js'
import { createSpeaker } from '../src/index.js'

const PCM = 'audio/l16; rate=24000; channels=1'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Движок: молчит `delay` мс (или падает), потом три кадра; отмена слышна. */
function engine(name: number, delay: number, o: { fail?: boolean; log?: string[] } = {}): TtsEngine & { aborted: number; calls: number } {
  const e = {
    kind: 'x',
    aborted: 0,
    calls: 0,
    voices: async () => [],
    design: async () => ({ id: '', cached: false }),
    async *speak(_t: string, _v: string, _o: unknown, signal?: AbortSignal): AsyncGenerator<AudioChunk> {
      e.calls++
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, delay)
        signal?.addEventListener('abort', () => {
          clearTimeout(t)
          e.aborted++
          rej(new Error('abort'))
        })
      })
      if (o.fail) throw new Error('упал')
      for (let i = 0; i < 3; i++) yield { data: new Uint8Array([name, i]), mime: PCM }
    },
  }
  return e
}

function memCache() {
  const m = new Map<string, Uint8Array>()
  return { m, get: async (k: string) => m.get(k), set: async (k: string, d: Uint8Array) => void m.set(k, d) }
}

function setup(primary: TtsEngine, pocket: TtsEngine, firstAudioMs = 40) {
  const cache = memCache()
  const events: PieceEvent[] = []
  const sp = createSpeaker({
    engines: { vertex: primary, pocket },
    defaultVoice: 'vertex:Sulafat',
    cache,
    parallel: { voice: 'pocket:clone', firstAudioMs },
    onPiece: (e) => events.push(e),
  })
  return { sp, cache, events }
}

async function bytes(gen: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = []
  for await (const b of gen) out.push(...b)
  return out
}

const P = [1, 0, 1, 1, 1, 2]
const B = [2, 0, 2, 1, 2, 2]

describe('гонка с параллельным голосом', () => {
  it('основной успел за порог — играет он, параллельный снят, кусок в кэше', async () => {
    const primary = engine(1, 5)
    const pocket = engine(2, 500)
    const { sp, cache, events } = setup(primary, pocket)
    expect(await bytes(sp.stream(['Раз.'], { play: 'now' }, 'pcm'))).toEqual(P)
    await sleep(5)
    expect(pocket.aborted).toBe(1)
    expect(cache.m.size).toBe(1)
    expect(events[0]).toMatchObject({ played: 'primary', voice: 'vertex:Sulafat' })
    expect(sp.stats).toMatchObject({ primary: 1, parallel: 0 })
  })

  it('порог прошёл — играет параллельный, под ключом основного его звука нет, основной дописан в кэш', async () => {
    const primary = engine(1, 120)
    const pocket = engine(2, 5)
    const { sp, cache, events } = setup(primary, pocket)
    expect(await bytes(sp.stream(['Раз.'], { play: 'now' }, 'pcm'))).toEqual(B)
    expect(primary.aborted).toBe(0)
    expect(cache.m.size).toBe(0)
    await sleep(150)
    expect([...cache.m.values()].map((d) => [...d])).toEqual([P])
    expect(events[0]).toMatchObject({ played: 'parallel', reason: 'нет звука за 40 мс' })
    expect(events[0]!.primaryMs).toBeGreaterThan(100)
    // Повтор — звук основного из кэша, без синтеза.
    expect(await bytes(sp.stream(['Раз.'], { play: 'now' }, 'pcm'))).toEqual(P)
    expect(primary.calls).toBe(1)
  })

  it('основной упал — параллельный сразу, порог не ждём', async () => {
    const primary = engine(1, 2, { fail: true })
    const pocket = engine(2, 2)
    const { sp, events } = setup(primary, pocket, 10_000)
    const t0 = Date.now()
    expect(await bytes(sp.stream(['Раз.'], { play: 'now' }, 'pcm'))).toEqual(B)
    expect(Date.now() - t0).toBeLessThan(500)
    await sleep(1)
    expect(events[0]).toMatchObject({ played: 'parallel', reason: 'упал' })
  })

  it('следующий кусок снова начинает с основного: выключения на время нет', async () => {
    const primary = engine(1, 120)
    const pocket = engine(2, 5)
    const { sp } = setup(primary, pocket)
    await bytes(sp.stream(['Раз.'], { play: 'now' }, 'pcm'))
    await bytes(sp.stream(['Два.'], { play: 'now' }, 'pcm'))
    expect(primary.calls).toBe(2)
  })

  it('оба упали — ошибка основного', async () => {
    const { sp } = setup(engine(1, 2, { fail: true }), engine(2, 2, { fail: true }))
    await expect(bytes(sp.stream(['Раз.'], { play: 'now' }, 'pcm'))).rejects.toThrow('упал')
  })

  it('предзагрузка не зовёт параллельный, сколько бы основной ни молчал', async () => {
    const primary = engine(1, 100)
    const pocket = engine(2, 1)
    const { sp, cache } = setup(primary, pocket)
    const r = await sp.synth('Раз.', { play: 'ahead' }, 'pcm')
    expect([...r.data]).toEqual(P)
    expect(pocket.calls).toBe(0)
    expect(cache.m.size).toBe(1)
  })

  it('порог — от момента «нужен»: заказан заранее, основной отвечает — параллельный не нужен', async () => {
    const primary = engine(1, 100)
    const pocket = engine(2, 1)
    const { sp, events } = setup(primary, pocket, 80)
    void sp.synth('Раз.', { play: 'ahead' }, 'pcm')
    await sleep(60)
    // Основной молчит 60 мс из 100; порог 80 от «нужен» — успевает, хотя от заказа прошло больше.
    expect(await bytes(sp.stream(['Раз.'], { play: 'now' }, 'pcm'))).toEqual(P)
    await sleep(1)
    expect(primary.calls).toBe(1)
    expect(events[0]).toMatchObject({ played: 'primary' })
    expect(events[0]!.aheadMs).toBeGreaterThanOrEqual(50)
  })

  it('заказан заранее, но основной завис: когда кусок понадобился — параллельный, основной дописан', async () => {
    const primary = engine(1, 200)
    const pocket = engine(2, 1)
    const { sp, cache, events } = setup(primary, pocket)
    void sp.synth('Раз.', { play: 'ahead' }, 'pcm')
    await sleep(20)
    expect(await bytes(sp.stream(['Раз.'], { play: 'now' }, 'pcm'))).toEqual(B)
    expect(primary.calls).toBe(1)
    await sleep(220)
    expect(events[0]).toMatchObject({ played: 'parallel' })
    expect([...cache.m.values()].map((d) => [...d])).toEqual([P])
  })

  it('кусок потока: следующий заказан заранее и не переводит всё на параллельный', async () => {
    const primary = engine(1, 60)
    const pocket = engine(2, 1)
    const { sp, events } = setup(primary, pocket, 200)
    const got = await bytes(sp.stream(['Раз.', 'Два.', 'Три.'], { play: 'now' }, 'pcm'))
    expect(got).toEqual([...P, ...P, ...P])
    await sleep(1)
    expect(events.map((e) => e.played)).toEqual(['primary', 'primary', 'primary'])
  })

  it('без `play` гонки нет (рендер книг, CLI); чужой голос не страхуется', async () => {
    const primary = engine(1, 80)
    const other = engine(3, 80)
    const pocket = engine(2, 1)
    const sp = createSpeaker({ engines: { vertex: primary, openai: other, pocket }, defaultVoice: 'vertex:Sulafat', parallel: { voice: 'pocket:clone', firstAudioMs: 10 } })
    expect((await bytes(sp.stream(['Раз.'], {}, 'pcm')))[0]).toBe(1)
    expect((await bytes(sp.stream(['Два.'], { voice: 'openai:x', play: 'now' }, 'pcm')))[0]).toBe(3)
    expect(pocket.calls).toBe(0)
  })
})
