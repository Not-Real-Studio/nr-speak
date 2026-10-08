import type { AudioChunk, TtsEngine } from '../src/index.js'

/** Структурно — IContext runz: `get(path)` по вложенным объектам, блоки — тоже с `get`. */
export function fakeCtx(data: Record<string, unknown>): { get(path: string[]): unknown } {
  const wrap = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? fakeCtx(v as Record<string, unknown>) : v)
  return {
    get(path) {
      let cur: unknown = data
      for (const k of path) {
        if (!cur || typeof cur !== 'object') return undefined
        cur = (cur as Record<string, unknown>)[k]
      }
      return wrap(cur)
    },
  }
}

/** Мок движка: пишет вызовы, отдаёт заданный звук. */
export function mockEngine(o: { kind?: string; voices?: string[]; nativeSpeed?: boolean; mime?: string; fail?: Error } = {}) {
  const calls: { text: string; voice: string; opts: Record<string, unknown> }[] = []
  const engine: TtsEngine = {
    kind: o.kind ?? 'mock',
    limit: 0,
    nativeSpeed: o.nativeSpeed ?? false,
    async voices() {
      return (o.voices ?? []).map((id) => ({ id, type: 'prebuilt' }))
    },
    async design() {
      throw new Error('нет')
    },
    async *speak(text, voice, opts): AsyncGenerator<AudioChunk> {
      calls.push({ text, voice, opts: { ...opts } })
      if (o.fail) throw o.fail
      const mime = o.mime ?? 'audio/l16; rate=24000; channels=1'
      yield { data: new TextEncoder().encode(`[${voice}:${text}]`), mime }
    },
  }
  return { engine, calls }
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
