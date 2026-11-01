import { describe, expect, it } from 'vitest'
import { openPollTranscription } from '../src/poll-live.js'

const sec = new Uint8Array(16000 * 2)
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const reply = (text: string): Response => new Response(JSON.stringify({ text }), { status: 200 })

describe('openPollTranscription: сервер лёг и ожил', () => {
  it('onHealth — только на смене состояния; без звука «ожил» не считается', async () => {
    let up = false
    const seen: Array<{ ok: boolean; reason?: string | undefined }> = []
    const fetchMock = (async () => {
      if (!up) throw new Error('fetch failed')
      return reply('привет')
    }) as typeof fetch
    const t = openPollTranscription({ baseUrl: 'http://m2/v1', model: 'gigaam', intervalMs: 5, fetch: fetchMock, onHealth: (h) => seen.push(h) })
    t.push(sec)
    await wait(40)
    expect(seen).toEqual([{ ok: false, reason: 'fetch failed' }])
    up = true
    t.push(sec)
    await wait(40)
    expect(seen.map((h) => h.ok)).toEqual([false, true])
    expect(await t.end()).toBe('привет')
  })

  it('лёг к концу записи: end отдаёт услышанное, пусто — ошибка', async () => {
    let n = 0
    const f = (async () => {
      if (n++ === 0) return reply('начало')
      throw new Error('fetch failed')
    }) as typeof fetch
    const a = openPollTranscription({ baseUrl: 'http://m2/v1', model: 'gigaam', intervalMs: 5, fetch: f })
    a.push(sec)
    await wait(30)
    a.push(sec)
    expect(await a.end()).toBe('начало')
    const b = openPollTranscription({ baseUrl: 'http://m2/v1', model: 'gigaam', intervalMs: 500, fetch: (async () => { throw new Error('fetch failed') }) as typeof fetch })
    b.push(sec)
    await expect(b.end()).rejects.toThrow('fetch failed')
  })

  it('запрос висит дольше timeoutMs — считается сбоем', async () => {
    const seen: boolean[] = []
    const hang = ((_u: unknown, i: RequestInit) =>
      new Promise((_, rej) => i.signal!.addEventListener('abort', () => rej(new Error('timeout'))))) as typeof fetch
    const t = openPollTranscription({ baseUrl: 'http://m2/v1', model: 'gigaam', intervalMs: 5, timeoutMs: 20, fetch: hang, onHealth: (h) => seen.push(h.ok) })
    t.push(sec)
    await wait(60)
    expect(seen).toEqual([false])
    t.close()
  })
})
