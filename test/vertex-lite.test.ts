import { describe, expect, it } from 'vitest'
import { createVertexEngine, speakBody, textLanguage } from '../src/gemini.js'

const sse = (): Response => {
  const data = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/L16;rate=24000' } }] } }] })}\n\n`
  return new Response(data, { status: 200 })
}

function engine(main: (signal?: AbortSignal | null) => Promise<Response>) {
  const calls: string[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url).includes('flash-lite-tts') ? 'lite' : 'main')
    return String(url).includes('flash-lite-tts') ? sse() : main(init?.signal)
  }) as typeof globalThis.fetch
  return { calls, e: createVertexEngine({ project: 'p', token: async () => 't', fetch, model: 'gemini-3.8-flash-tts', liteFirstMs: 30 }) }
}

const play = async (e: ReturnType<typeof engine>['e']): Promise<number> => {
  let n = 0
  for await (const _ of e.speak('текст', 'Sulafat', {})) n++
  return n
}

describe('Vertex: запасная модель', () => {
  it('по умолчанию основная — lite, запасная — обычная', async () => {
    const calls: string[] = []
    const fetch = (async (url: string) => {
      calls.push(String(url).includes('flash-lite-tts') ? 'lite' : 'main')
      return calls.length === 1 ? new Response('{}', { status: 429 }) : sse()
    }) as typeof globalThis.fetch
    const e = createVertexEngine({ project: 'p', token: async () => 't', fetch })
    expect(await play(e)).toBe(1)
    expect(calls).toEqual(['lite', 'main'])
  })

  it('основная отвечает — lite не зовётся', async () => {
    const { e, calls } = engine(async () => sse())
    expect(await play(e)).toBe(1)
    expect(calls).toEqual(['main'])
  })

  it('429 — сразу lite, без повторов основной', async () => {
    const { e, calls } = engine(async () => new Response('{"error":{"message":"Resource exhausted"}}', { status: 429 }))
    expect(await play(e)).toBe(1)
    expect(calls).toEqual(['main', 'lite'])
  })

  it('молчит дольше порога — отмена и lite', async () => {
    const { e, calls } = engine((signal) => new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('abort')))))
    expect(await play(e)).toBe(1)
    expect(calls).toEqual(['main', 'lite'])
  })
})

describe('язык реплики', () => {
  it('русский текст — ru-RU, в том числе с английскими терминами', () => {
    expect(textLanguage('Запустил runz release, всё прошло.')).toBe('ru-RU')
    const cfg = (speakBody('Привет', 'Sulafat', {}).generationConfig as { speechConfig: Record<string, unknown> }).speechConfig
    expect(cfg.languageCode).toBe('ru-RU')
  })

  it('английский текст и текст без букв — автоопределение', () => {
    expect(textLanguage('Hello, this is a plain English sentence.')).toBeUndefined()
    expect(textLanguage('12345')).toBeUndefined()
  })
})
