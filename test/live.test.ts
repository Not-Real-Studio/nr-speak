import { describe, expect, it } from 'vitest'
import type { LiveSocket } from '../src/live.js'
import { liveLanguage, liveSetup, liveUrl, openLiveTranscription, pcmToWav } from '../src/live.js'

/** Мок сокета Live API: записывает отправленное, сервер — методами теста. */
class FakeSocket implements LiveSocket {
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: Record<string, unknown>[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
  }
  server(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** Ответ провайдера на `activityEnd`: финал и конец активности. */
  finalize(text: string): void {
    this.server({ serverContent: { inputTranscription: { text } } })
    this.server({ serverContent: { generationComplete: true } })
    this.server({ serverContent: {}, voiceActivity: { type: 'ACTIVITY_END' } })
  }
  drop(code = 1011, reason = 'internal'): void {
    this.closed = true
    this.onclose?.({ code, reason })
  }
  kinds(): string[] {
    return this.sent.map((m) => (m.setup ? 'setup' : Object.keys((m.realtimeInput ?? {}) as object)[0]!))
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const pcm = (n = 3200): Uint8Array => new Uint8Array(n).fill(1)

function setupLive(extra: Partial<Parameters<typeof openLiveTranscription>[0]> = {}) {
  FakeSocket.all = []
  const partials: string[] = []
  const events: string[] = []
  const errors: Error[] = []
  let t = 0
  const live = openLiveTranscription({
    apiKey: 'k',
    WebSocket: FakeSocket,
    vocabulary: ['speak', 'nrchat', 'speak'],
    language: 'ru',
    now: () => t,
    onPartial: (s) => partials.push(s),
    onEvent: (e) => events.push(`${e.type}:${e.session}`),
    onError: (e) => errors.push(e),
    ...extra,
  })
  return { live, partials, events, errors, advance: (ms: number) => (t += ms) }
}

describe('live: адрес и setup', () => {
  it('wss, ключ в query; язык с регионом; словарь без дублей, SMART, ручная активность', () => {
    expect(liveUrl('a b')).toBe('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=a%20b')
    expect(liveUrl('k', 'http://127.0.0.1:9/x')).toMatch(/^ws:\/\/127\.0\.0\.1:9\/ws\//)
    expect(liveLanguage('ru')).toBe('ru-RU')
    expect(liveLanguage('en-GB')).toBe('en-GB')
    expect(liveSetup({ language: 'ru', vocabulary: ['speak', ' speak ', 'nrchat'] })).toEqual({
      setup: {
        model: 'models/gemini-3.5-transcribe-live',
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { mode: 'SMART', languageCodes: ['ru-RU'], customVocabulary: ['speak', 'nrchat'] },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
    })
    expect((liveSetup({ mode: 'verbatim' }).setup as { inputAudioTranscription: unknown }).inputAudioTranscription).toEqual({ mode: 'VERBATIM' })
  })

  it('частота не 16/24 кГц — ошибка', () => {
    expect(() => openLiveTranscription({ apiKey: 'k', WebSocket: FakeSocket, rate: 44100 as 16000 })).toThrow(/16000 или 24000/)
  })

  it('pcmToWav: заголовок RIFF и данные', () => {
    const w = pcmToWav(new Uint8Array([1, 2, 3, 4]), 16000)
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe('RIFF')
    expect(new DataView(w.buffer).getUint32(24, true)).toBe(16000)
    expect([...w.subarray(44)]).toEqual([1, 2, 3, 4])
  })
})

describe('live: запись', () => {
  it('звук до setupComplete — в очереди; interim нарастает; финал по activityEnd', async () => {
    const { live, partials } = setupLive()
    live.push(pcm())
    await tick()
    const ws = FakeSocket.all[0]!
    expect(ws.kinds()).toEqual(['setup'])
    ws.server({ setupComplete: {} })
    await live.ready
    expect(ws.kinds()).toEqual(['setup', 'activityStart', 'audio'])
    expect((ws.sent[2]!.realtimeInput as { audio: { mimeType: string } }).audio.mimeType).toBe('audio/pcm;rate=16000')
    live.push(pcm())
    ws.server({ serverContent: { interimInputTranscription: { text: 'Привет' } } })
    ws.server({ serverContent: { interimInputTranscription: { text: 'Привет, мир' } } })
    expect(partials).toEqual(['Привет', 'Привет, мир'])
    const done = live.end()
    expect(ws.kinds().at(-1)).toBe('activityEnd')
    ws.finalize('Привет, мир.')
    expect(await done).toBe('Привет, мир.')
    expect(ws.closed).toBe(true)
  })

  it('ротация сессии по времени: старая отдаёт финал, звук идёт в новую, текст склеен', async () => {
    const { live, events, advance } = setupLive({ sessionMs: 1000 })
    await tick()
    const a = FakeSocket.all[0]!
    a.server({ setupComplete: {} })
    live.push(pcm())
    a.server({ serverContent: { interimInputTranscription: { text: 'Первая часть' } } })
    advance(1000)
    live.push(pcm(10))
    expect(events).toEqual(['rotate:2'])
    expect(a.kinds().at(-1)).toBe('activityEnd')
    await tick()
    const b = FakeSocket.all[1]!
    expect(b.kinds()).toEqual(['setup'])
    a.finalize('Первая часть.')
    b.server({ setupComplete: {} })
    expect(b.kinds()).toEqual(['setup', 'activityStart', 'audio'])
    b.server({ serverContent: { interimInputTranscription: { text: 'вторая' } } })
    expect(live.text()).toBe('Первая часть. вторая')
    const done = live.end()
    b.finalize('Вторая.')
    expect(await done).toBe('Первая часть. Вторая.')
    expect(live.sessions).toBe(2)
  })

  it('goAway — сразу новая сессия', async () => {
    const { live, events } = setupLive()
    await tick()
    FakeSocket.all[0]!.server({ setupComplete: {} })
    FakeSocket.all[0]!.server({ goAway: { timeLeft: '10s' } })
    expect(events).toEqual(['goaway:2', 'rotate:2'])
    live.close()
  })

  it('обрыв посреди записи — переподключение, interim оборванной остаётся', async () => {
    const { live, events } = setupLive()
    await tick()
    const a = FakeSocket.all[0]!
    a.server({ setupComplete: {} })
    a.server({ serverContent: { interimInputTranscription: { text: 'до обрыва' } } })
    a.drop()
    expect(events).toEqual(['reconnect:2'])
    live.push(pcm())
    await tick()
    const b = FakeSocket.all[1]!
    b.server({ setupComplete: {} })
    expect(b.kinds()).toEqual(['setup', 'activityStart', 'audio'])
    const done = live.end()
    b.finalize('после')
    expect(await done).toBe('до обрыва после')
  })

  it('первая сессия не поднялась — ready и end с ошибкой', async () => {
    const { live, errors } = setupLive()
    await tick()
    FakeSocket.all[0]!.drop(1008, 'API key not valid')
    await expect(live.ready).rejects.toThrow(/API key not valid/)
    await expect(live.end()).rejects.toThrow(/API key not valid/)
    expect(errors).toHaveLength(1)
  })

  it('финал не пришёл за finalTimeoutMs — берётся interim', async () => {
    const { live } = setupLive({ finalTimeoutMs: 20 })
    await tick()
    const a = FakeSocket.all[0]!
    a.server({ setupComplete: {} })
    a.server({ serverContent: { interimInputTranscription: { text: 'как было' } } })
    expect(await live.end()).toBe('как было')
  })

  it('конец до setupComplete — activityEnd после очереди', async () => {
    const { live } = setupLive()
    live.push(pcm())
    const done = live.end()
    await tick()
    const a = FakeSocket.all[0]!
    a.server({ setupComplete: {} })
    expect(a.kinds()).toEqual(['setup', 'activityStart', 'audio', 'activityEnd'])
    a.finalize('коротко')
    expect(await done).toBe('коротко')
  })
})
