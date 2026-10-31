import { describe, expect, it } from 'vitest'
import { createFallbackEngine, createLocalEngine, createSpeaker, isSampleRef, resolveVoice, sampleId } from '../src/index.js'
import type { AudioChunk, Engines, SpeakOpts, TtsEngine } from '../src/index.js'
import { enginesFromCtx } from '../src/node/index.js'

const pcm = (n: number): Uint8Array => new Uint8Array(n).fill(1)

/** Поддельный local_tts: образцы в памяти, звук — двумя кусками (второй — нечётной длины). */
function fakeServer(o: { delayMs?: number; down?: boolean } = {}) {
  const voices = new Map<string, string>()
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, ...(body ? { body } : {}) })
    if (o.down) throw new TypeError('fetch failed')
    if (o.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, o.delayMs)
        init?.signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('aborted', 'AbortError'))))
      })
    }
    if (u.pathname.startsWith('/v1/voices/')) {
      voices.set(u.pathname.split('/').pop()!, String(body?.text ?? ''))
      return new Response(JSON.stringify({ id: 'x' }))
    }
    if (u.pathname === '/v1/audio/voices') return new Response(JSON.stringify({ voices: [...voices.keys()].map((id) => ({ id })) }))
    if (u.pathname === '/v1/audio/speech') {
      const v = String(body?.voice ?? '')
      if (v.startsWith('s-') && !voices.has(v)) return new Response(JSON.stringify({ error: { code: 'voice_not_found' } }), { status: 404 })
      const parts = [pcm(3), pcm(5)]
      return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close() } }), { headers: { 'content-type': 'audio/l16; rate=24000; channels=1' } })
    }
    return new Response('nf', { status: 404 })
  }) as typeof fetch
  return { fetch: f, calls, voices }
}

const sample = async () => ({ audio: pcm(100), text: 'Привет' })

async function all(it: AsyncIterable<AudioChunk>): Promise<AudioChunk[]> {
  const out: AudioChunk[] = []
  for await (const c of it) out.push(c)
  return out
}

describe('local engines (DEV-520)', () => {
  it('путь к образцу — один PUT по хэшу, дальше голос — id; PCM по чётной границе', async () => {
    const s = fakeServer()
    const e = createLocalEngine({ kind: 'omnivoice', baseUrl: 'http://lap:8095/v1/', fetch: s.fetch, loadSample: sample })
    const a = await all(e.speak('Раз.', '~/v/denis.wav', {}))
    await all(e.speak('Два.', '~/v/denis.wav', {}))
    const id = await sampleId(await sample())
    expect(s.calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    expect(s.calls.filter((c) => c.path === '/v1/audio/speech').map((c) => c.body?.voice)).toEqual([id, id])
    expect(a.map((c) => c.data.length)).toEqual([2, 6])
    expect(a[0]!.mime).toBe('audio/l16; rate=24000; channels=1')
  })

  it('сервер потерял образец — грузит заново и повторяет', async () => {
    const s = fakeServer()
    const e = createLocalEngine({ kind: 'pocket', baseUrl: 'http://m2:8096', fetch: s.fetch, loadSample: sample })
    await all(e.speak('Раз.', '/v/denis.wav', {}))
    s.voices.clear()
    await all(e.speak('Два.', '/v/denis.wav', {}))
    expect(s.calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
  })

  it('pocket: design: → голос по умолчанию; id — как есть', async () => {
    const s = fakeServer()
    const e = createLocalEngine({ kind: 'pocket', baseUrl: 'http://m2:8096', fetch: s.fetch })
    await all(e.speak('Раз.', 'design:male, low', {}))
    await all(e.speak('Раз.', 'narrator', { instruct: 'тихо' }))
    expect(s.calls.map((c) => c.body?.voice)).toEqual(['', 'narrator'])
    expect(s.calls[1]!.body?.instructions).toBe('тихо')
  })

  it('isSampleRef', () => {
    expect(isSampleRef('~/a.wav')).toBe(true)
    expect(isSampleRef('E:/a')).toBe(true)
    expect(isSampleRef('s-abc')).toBe(false)
    expect(isSampleRef('design:male')).toBe(false)
  })

  it('переход на запасной: лаптоп лежит — pocket, потом пропуск без попытки', async () => {
    const lap = fakeServer({ down: true })
    const m2 = fakeServer()
    let t = 0
    const events: { reason: string; skipped: boolean }[] = []
    const e = createFallbackEngine(createLocalEngine({ kind: 'omnivoice', baseUrl: 'http://lap', fetch: lap.fetch }), createLocalEngine({ kind: 'pocket', baseUrl: 'http://m2', fetch: m2.fetch }), { now: () => t, cooldownMs: 1000, onFallback: (x) => events.push(x) })
    const a = await all(e.speak('Раз.', '', {}))
    expect(a[0]!.fallback).toBe('pocket')
    await all(e.speak('Два.', '', {}))
    expect(lap.calls).toHaveLength(1)
    expect(events.map((x) => x.skipped)).toEqual([false, true])
    t = 2000
    await all(e.speak('Три.', '', {}))
    expect(lap.calls).toHaveLength(2)
  })

  it('переход на запасной: нет первого звука за порог', async () => {
    const lap = fakeServer({ delayMs: 500 })
    const m2 = fakeServer()
    const e = createFallbackEngine(createLocalEngine({ kind: 'omnivoice', baseUrl: 'http://lap', fetch: lap.fetch }), createLocalEngine({ kind: 'pocket', baseUrl: 'http://m2', fetch: m2.fetch }), { firstAudioMs: 50 })
    const t0 = Date.now()
    const a = await all(e.speak('Раз.', '', {}))
    expect(Date.now() - t0).toBeLessThan(400)
    expect(a.every((c) => c.fallback === 'pocket')).toBe(true)
  })

  it('основной успел — без пометки; отмена вызывающим не уводит в запасной', async () => {
    const lap = fakeServer()
    const m2 = fakeServer()
    const e = createFallbackEngine(createLocalEngine({ kind: 'omnivoice', baseUrl: 'http://lap', fetch: lap.fetch }), createLocalEngine({ kind: 'pocket', baseUrl: 'http://m2', fetch: m2.fetch }))
    const a = await all(e.speak('Раз.', '', {}))
    expect(a.some((c) => c.fallback)).toBe(false)
    const slow = createFallbackEngine(createLocalEngine({ kind: 'omnivoice', baseUrl: 'http://lap', fetch: fakeServer({ delayMs: 300 }).fetch }), createLocalEngine({ kind: 'pocket', baseUrl: 'http://m2', fetch: m2.fetch }))
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    await expect(all(slow.speak('Раз.', '', {}, ac.signal))).rejects.toThrow()
    expect(m2.calls).toHaveLength(0)
  })

  it('speaker не кладёт в кэш звук запасного', async () => {
    const store = new Map<string, Uint8Array>()
    const cache = { get: async (k: string) => store.get(k), set: async (k: string, d: Uint8Array) => void store.set(k, d) }
    const backup: TtsEngine = { kind: 'pocket', voices: async () => [], design: async () => ({ id: '', cached: false }), async *speak() { yield { data: pcm(4), mime: 'audio/l16; rate=24000; channels=1' } } }
    const broken: TtsEngine = { kind: 'omnivoice', voices: async () => [], design: async () => ({ id: '', cached: false }), async *speak() { throw new Error('down') } }
    const sp = createSpeaker({ engines: { omnivoice: createFallbackEngine(broken, backup) }, cache, hedgeMs: 0 })
    await sp.synth('Раз.', { voice: 'omnivoice:' }, 'pcm')
    const chunks: Uint8Array[] = []
    for await (const b of sp.stream(['Два.'], { voice: 'omnivoice:design:male' }, 'pcm')) chunks.push(b)
    expect(chunks.length).toBeGreaterThan(0)
    expect(store.size).toBe(0)
  })

  it('резолв: omnivoice:<путь> — как есть', async () => {
    const e = createLocalEngine({ kind: 'omnivoice', baseUrl: 'http://lap', fetch: fakeServer().fetch })
    expect(await resolveVoice({ omnivoice: e }, 'omnivoice:~/Studio/data/denis.wav')).toEqual({ engine: 'omnivoice', voice: '~/Studio/data/denis.wav' })
  })

  it('конфиг: оба адреса — omnivoice с переходом, $omnivoice_fallback: off — без', () => {
    const ctxOf = (o: Record<string, string>) => ({ get: (p: string[]) => (p[0] === 'speak' ? o[p[1]!] : undefined) })
    const both = enginesFromCtx(ctxOf({ engines: 'omnivoice, pocket', omnivoice_url: 'http://lap:8095', pocket_url: 'http://m2:8096' }), { cache: { get: () => undefined, set: () => {} } })
    expect(Object.keys(both).sort()).toEqual(['omnivoice', 'pocket'])
    expect(both.omnivoice!.voices).not.toBe(both.pocket!.voices)
    const off = enginesFromCtx(ctxOf({ engines: 'omnivoice', omnivoice_url: 'http://lap:8095', omnivoice_fallback: 'off' }), { cache: { get: () => undefined, set: () => {} } })
    expect(Object.keys(off)).toEqual(['omnivoice'])
  })
})

describe('очередь локального движка (DEV-581)', () => {
  const pcm = new Uint8Array(480)
  const silentEngine = (delay: () => Promise<void>, promoted: string[] = []): TtsEngine => ({
    kind: 'omnivoice',
    limit: 0,
    voices: async () => [],
    design: async () => ({ id: 'x', cached: false }),
    promote: (job) => void promoted.push(job),
    async *speak() {
      await delay()
      yield { data: pcm, mime: 'audio/l16; rate=24000; channels=1' }
    },
  })
  const spareEngine: TtsEngine = {
    kind: 'pocket',
    limit: 0,
    voices: async () => [],
    design: async () => ({ id: 'x', cached: false }),
    async *speak() {
      yield { data: pcm, mime: 'audio/l16; rate=24000; channels=1' }
    },
  }

  it('порог не считает очередь предзагрузки: идёт с promote', async () => {
    let go = (): void => {}
    const gate = new Promise<void>((r) => (go = r))
    const fb = createFallbackEngine(silentEngine(() => gate), spareEngine, { firstAudioMs: 20 })
    const it = fb.speak('т', 'v', { priority: 'ahead', job: 'j1' })[Symbol.asyncIterator]()
    const next = it.next()
    await new Promise((r) => setTimeout(r, 60))
    go()
    const n = await next
    expect(n.done).toBe(false)
    expect((n.value as { fallback?: string }).fallback).toBeUndefined()
  })

  it('понадобившийся кусок без звука за порог уходит запасному', async () => {
    const promoted: string[] = []
    const fb = createFallbackEngine(silentEngine(() => new Promise(() => {}), promoted), spareEngine, { firstAudioMs: 20 })
    const it = fb.speak('т', 'v', { priority: 'ahead', job: 'j2' })[Symbol.asyncIterator]()
    const next = it.next()
    await new Promise((r) => setTimeout(r, 40))
    fb.promote?.('j2')
    const n = await next
    expect(promoted).toEqual(['j2'])
    expect((n.value as { fallback?: string }).fallback).toBe('pocket')
  })

  it('локальный движок шлёт priority и job, promote — POST очереди', async () => {
    const calls: { url: string; body?: unknown }[] = []
    const engine = createLocalEngine({
      kind: 'omnivoice',
      baseUrl: 'http://x',
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
        return new Response(url.endsWith('/now') ? '{}' : pcm)
      }) as typeof fetch,
    })
    for await (const _ of engine.speak('т', 'v', { priority: 'ahead', job: 'j3' })) void _
    engine.promote?.('j3')
    expect(calls[0]!.body).toMatchObject({ priority: 'ahead', job: 'j3' })
    expect(calls[1]!.url).toBe('http://x/v1/queue/j3/now')
  })
})

describe('speaker: один синтез на кусок (DEV-581)', () => {
  const mime = 'audio/l16; rate=24000; channels=1'
  const setup = () => {
    const seen: SpeakOpts[] = []
    const promoted: string[] = []
    const aborted: boolean[] = []
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const engine: TtsEngine = {
      kind: 'omnivoice',
      limit: 0,
      voices: async () => [{ id: 'v', type: 'prebuilt', name: 'v', lang: 'ru-RU' }],
      design: async () => ({ id: 'x', cached: false }),
      promote: (j) => void promoted.push(j),
      async *speak(_t, _v, opts, signal) {
        seen.push(opts)
        signal?.addEventListener('abort', () => aborted.push(true))
        yield { data: new Uint8Array(4), mime }
        await Promise.race([gate, new Promise<void>((_, rej) => signal?.addEventListener('abort', () => rej(new Error('снято'))))])
        yield { data: new Uint8Array(4), mime }
      },
    }
    const speaker = createSpeaker({ engines: { omnivoice: engine } as Engines, defaultVoice: 'omnivoice:v' })
    return { speaker, seen, promoted, aborted, release: () => release() }
  }

  it('кусок из предзагрузки играет потоком и повышается в очереди', async () => {
    const t = setup()
    const early = t.speaker.synth('фраза', { play: 'ahead' }, 'pcm')
    early.catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    const it = t.speaker.stream(['фраза'], { play: 'now' }, 'pcm')[Symbol.asyncIterator]()
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(t.seen).toHaveLength(1)
    expect(t.seen[0]).toMatchObject({ priority: 'ahead' })
    expect(t.promoted).toEqual([t.seen[0]!.job])
    t.release()
    for (let n = await it.next(); !n.done; n = await it.next()) void n
    await early
  })

  it('все клиенты предзагрузки ушли — синтез снимается', async () => {
    const t = setup()
    const ac = new AbortController()
    const it = t.speaker.stream(['фраза'], { play: 'ahead' }, 'pcm', ac.signal)[Symbol.asyncIterator]()
    const n = it.next()
    n.catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    await expect(n).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 5))
    expect(t.aborted).toEqual([true])
  })
})
