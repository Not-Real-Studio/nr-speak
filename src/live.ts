/**
 * Распознавание потоком (LLM-4): `gemini-3.5-transcribe-live` через Live API AI Studio
 * (`BidiGenerateContent`, WebSocket). Без Node: сокет — стандартный `WebSocket` (глобальный в
 * Node 22+ и браузере) или инъекция.
 *
 * Протокол провайдера (проверен 16.10.2026): `setup` с `inputAudioTranscription`
 * (`languageCodes`, `customVocabulary`, `mode: SMART|VERBATIM`) и выключенным автоматическим VAD →
 * `setupComplete` → `activityStart` → звук `audio/pcm;rate=16000|24000` (PCM16 моно LE) →
 * `activityEnd`. Сервер шлёт `interimInputTranscription.text` — весь текст активности до сих пор
 * (нарастает), по концу активности — `inputTranscription.text` (финал; в SMART — чистовой),
 * `generationComplete` и `voiceActivity: ACTIVITY_END`. Финал — через 0,4–0,8 с после `activityEnd`.
 *
 * Сессия провайдера живёт ~10 минут, `sessionResumption` у transcribe-live не приходит. Поэтому
 * длинная запись — цепочка сессий: за `sessionMs` до лимита (и по `goAway`) открывается новая,
 * звук копится в её очередь, пока она не готова; старая получает `activityEnd` и отдаёт свой финал.
 * Текст записи — финалы сессий подряд + interim текущей: ничего не теряется на стыке. Обрыв
 * сессии посреди записи — то же переподключение (её interim остаётся текстом), до `reconnects` раз.
 */

import { statusError } from './types.js'

export const LIVE_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live'
/** Частоты, которые провайдер берёт как есть. */
export const LIVE_RATES = [16000, 24000] as const
export type LiveRate = (typeof LIVE_RATES)[number]
/** Смена сессии провайдера — до его лимита в 10 мин. */
export const LIVE_SESSION_MS = 9 * 60_000
export const isLiveRate = (v: unknown): v is LiveRate => (LIVE_RATES as readonly unknown[]).includes(v)

/** То, что нужно от сокета: подмножество стандартного `WebSocket`. */
export interface LiveSocket {
  readonly readyState: number
  binaryType?: string
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}
export type LiveSocketCtor = new (url: string) => LiveSocket

export interface LiveEvent {
  type: 'rotate' | 'reconnect' | 'goaway' | 'short-final'
  /** Номер новой сессии (первая — 1). */
  session: number
  reason?: string | undefined
}

export interface LiveTranscribeOpts {
  apiKey: string
  /** Корень API (`https://generativelanguage.googleapis.com`); путь срезается. */
  baseUrl?: string | undefined
  model?: string | undefined
  rate?: LiveRate | undefined
  /** BCP-47 (`ru`, `ru-RU`); нет — автоопределение. */
  language?: string | undefined
  vocabulary?: readonly string[] | undefined
  /** `smart` (по умолчанию: без слов-паразитов, с самоисправлениями и форматированием) | `verbatim`. */
  mode?: 'smart' | 'verbatim' | undefined
  /** Через сколько менять сессию провайдера, мс (по умолчанию 9 мин). */
  sessionMs?: number | undefined
  /** Сколько ждать финал сессии после `activityEnd`, мс; не пришёл — берётся её interim. */
  finalTimeoutMs?: number | undefined
  /** Сколько ждать `setupComplete`, мс. */
  connectTimeoutMs?: number | undefined
  /** Переподключений при обрыве посреди записи. */
  reconnects?: number | undefined
  WebSocket?: LiveSocketCtor | undefined
  now?: (() => number) | undefined
  /** Текст записи целиком (финалы прошлых сессий + interim текущей) — на каждое изменение. */
  onPartial?: ((text: string) => void) | undefined
  /** Смена сессии, переподключение, `goAway` — для лога. */
  onEvent?: ((e: LiveEvent) => void) | undefined
  /** Неустранимая ошибка (первая сессия не поднялась, обрывы сверх `reconnects`). */
  onError?: ((err: Error) => void) | undefined
}

export interface LiveTranscription {
  /** Первая сессия готова (`setupComplete`); ошибка подключения — reject. */
  readonly ready: Promise<void>
  /** Кусок PCM16 моно LE на частоте `rate`. До готовности сессии копится в очередь. */
  push(pcm: Uint8Array): void
  /** Конец речи: `activityEnd` всем сессиям, финалы → текст записи. Сокеты закрываются. */
  end(): Promise<string>
  /** Отмена без финала. */
  close(): void
  /** Текст сейчас. */
  text(): string
  /** Сколько сессий провайдера было. */
  readonly sessions: number
}

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com'

/** Адрес Live API: ключ — в query (так требует провайдер); адрес не логировать. */
export function liveUrl(apiKey: string, baseUrl?: string): string {
  let origin = GEMINI_ROOT
  try {
    if (baseUrl) origin = new URL(baseUrl).origin
  } catch {
    // кривой baseUrl — корень по умолчанию
  }
  return `${origin.replace(/^http/, 'ws')}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`
}

/** Язык для провайдера: `ru` → `ru-RU` (ему нужен регион), прочее — как есть. */
const REGION: Record<string, string> = { ru: 'ru-RU', en: 'en-US', uk: 'uk-UA', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pl: 'pl-PL', pt: 'pt-BR' }
export const liveLanguage = (lang: string): string => (lang.includes('-') ? lang : (REGION[lang.toLowerCase()] ?? lang))

/** Сообщение `setup` сессии. */
export function liveSetup(o: Pick<LiveTranscribeOpts, 'model' | 'language' | 'vocabulary' | 'mode'>): Record<string, unknown> {
  const cfg: Record<string, unknown> = { mode: o.mode === 'verbatim' ? 'VERBATIM' : 'SMART' }
  if (o.language) cfg.languageCodes = [liveLanguage(o.language)]
  const vocab = [...new Set((o.vocabulary ?? []).map((w) => w.trim()).filter(Boolean))].slice(0, 1000)
  if (vocab.length) cfg.customVocabulary = vocab
  return {
    setup: {
      model: `models/${o.model || LIVE_TRANSCRIBE_MODEL}`,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: cfg,
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    },
  }
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const joinText = (parts: readonly string[]): string => parts.map((p) => p.trim()).filter(Boolean).join(' ')

interface ServerMsg {
  setupComplete?: unknown
  serverContent?: { interimInputTranscription?: { text?: string }; inputTranscription?: { text?: string }; generationComplete?: boolean }
  voiceActivity?: { type?: string }
  goAway?: { timeLeft?: string }
}

interface Session {
  n: number
  ws: LiveSocket
  state: 'connecting' | 'ready' | 'ending' | 'done'
  /** Звук до `setupComplete`. */
  queue: string[]
  /** `activityEnd` попросили до готовности. */
  endAsked: boolean
  finals: string[]
  interim: string
  /** Самый длинный interim сессии — страховка, если финал провайдера пришёл обрезанным. */
  heard: string
  opened: number
  done: Promise<void>
  finish: () => void
  timer?: ReturnType<typeof setTimeout> | undefined
}

export function openLiveTranscription(o: LiveTranscribeOpts): LiveTranscription {
  const WSOrNone = o.WebSocket ?? (globalThis as { WebSocket?: LiveSocketCtor }).WebSocket
  if (!WSOrNone) throw new Error('listen live: нет WebSocket (Node 22+ или инъекция)')
  const WS: LiveSocketCtor = WSOrNone
  const rate = o.rate ?? 16000
  if (!isLiveRate(rate)) throw statusError(`listen live: частота ${String(rate)} — нужна 16000 или 24000`, 400)
  const now = o.now ?? Date.now
  const sessionMs = o.sessionMs ?? LIVE_SESSION_MS
  const finalTimeout = o.finalTimeoutMs ?? 8000
  const connectTimeout = o.connectTimeoutMs ?? 10_000
  const reconnects = o.reconnects ?? 3
  const url = liveUrl(o.apiKey, o.baseUrl)
  const setup = JSON.stringify(liveSetup(o))
  const mime = `audio/pcm;rate=${rate}`
  const sessions: Session[] = []
  let cur: Session
  let ending = false
  let closed = false
  let failures = 0
  let fatal: Error | null = null
  let readyResolve!: () => void
  let readyReject!: (e: Error) => void
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res
    readyReject = rej
  })
  ready.catch(() => {})

  const text = (): string => joinText(sessions.map((s) => joinText([...s.finals, s.interim])))
  const emit = (): void => {
    if (!closed) o.onPartial?.(text())
  }

  function fail(err: Error): void {
    if (fatal) return
    fatal = err
    readyReject(err)
    o.onError?.(err)
    for (const s of sessions) finishSession(s)
  }

  function finishSession(s: Session): void {
    if (s.state === 'done') return
    s.state = 'done'
    if (s.timer) clearTimeout(s.timer)
    // Финал есть — interim им уже покрыт; нет (таймаут, обрыв) — interim остаётся текстом.
    // Финал заметно короче услышанного (провайдер отдал только первый кусок, 18.10:
    // 35 с речи → одна фраза) — берём услышанное.
    const fin = joinText(s.finals)
    if (s.finals.length && fin.length >= s.heard.length * 0.7) s.interim = ''
    else if (s.heard.length > fin.length) {
      if (s.finals.length) o.onEvent?.({ type: 'short-final', session: s.n, reason: `финал ${fin.length} симв. против услышанных ${s.heard.length}` })
      s.finals = []
      s.interim = s.heard
    }
    try {
      s.ws.close(1000)
    } catch {
      // уже закрыт
    }
    s.finish()
  }

  function sendEnd(s: Session): void {
    s.state = 'ending'
    s.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }))
    s.timer = setTimeout(() => finishSession(s), finalTimeout)
  }

  function open(): Session {
    const n = sessions.length + 1
    let finish!: () => void
    const done = new Promise<void>((r) => (finish = r))
    const ws = new WS(url)
    const s: Session = { n, ws, state: 'connecting', queue: [], endAsked: false, finals: [], interim: '', heard: '', opened: now(), done, finish }
    sessions.push(s)
    try {
      ws.binaryType = 'arraybuffer'
    } catch {
      // не у всех сокетов
    }
    s.timer = setTimeout(() => {
      if (s.state !== 'connecting') return
      lost(s, `нет setupComplete за ${connectTimeout} мс`)
    }, connectTimeout)
    ws.onopen = () => ws.send(setup)
    ws.onmessage = (ev) => {
      let msg: ServerMsg
      try {
        const d = ev.data
        msg = JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d instanceof ArrayBuffer ? new Uint8Array(d) : (d as Uint8Array))) as ServerMsg
      } catch {
        return
      }
      if (msg.setupComplete !== undefined && s.state === 'connecting') {
        if (s.timer) clearTimeout(s.timer)
        s.state = 'ready'
        failures = 0
        ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }))
        for (const m of s.queue) ws.send(m)
        s.queue = []
        if (n === 1) readyResolve()
        if (s.endAsked) sendEnd(s)
        return
      }
      const sc = msg.serverContent
      if (typeof sc?.interimInputTranscription?.text === 'string') {
        s.interim = sc.interimInputTranscription.text
        if (s.interim.length > s.heard.length) s.heard = s.interim
        emit()
      }
      if (typeof sc?.inputTranscription?.text === 'string') {
        s.finals.push(sc.inputTranscription.text)
        s.interim = ''
        emit()
      }
      // Финал может прийти несколькими кусками после ACTIVITY_END — короткая пауза, чтобы собрать все.
      if (msg.voiceActivity?.type === 'ACTIVITY_END' && s.state === 'ending') {
        if (s.timer) clearTimeout(s.timer)
        s.timer = setTimeout(() => finishSession(s), 400)
      }
      if (msg.goAway && s === cur && !ending) {
        o.onEvent?.({ type: 'goaway', session: n + 1, reason: msg.goAway.timeLeft })
        rotate()
      }
    }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      if (s.state === 'done') return
      if (s.state === 'ending') return finishSession(s)
      lost(s, `сокет закрыт ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`)
    }
    return s
  }

  /** Сессия оборвалась до финала: её текст остаётся, запись продолжается в новой. */
  function lost(s: Session, reason: string): void {
    const wasConnecting = s.state === 'connecting'
    const queued = s.queue
    finishSession(s)
    if (closed || fatal) return
    if (s.n === 1 && wasConnecting) return fail(statusError(`listen live: ${o.model || LIVE_TRANSCRIBE_MODEL} — ${reason}`, 502))
    if (s !== cur) return
    if (ending && !queued.length) return
    if (++failures > reconnects) return fail(statusError(`listen live: обрывы подряд (${failures - 1}), последний — ${reason}`, 502))
    cur = open()
    // Звук, не дошедший до оборванной сессии, — в новую.
    cur.queue.push(...queued)
    if (ending) cur.endAsked = true
    o.onEvent?.({ type: 'reconnect', session: cur.n, reason })
  }

  function rotate(): void {
    const old = cur
    cur = open()
    o.onEvent?.({ type: 'rotate', session: cur.n })
    if (old.state === 'ready') sendEnd(old)
    else old.endAsked = true
  }

  cur = open()

  return {
    ready,
    get sessions() {
      return sessions.length
    },
    text,
    push(pcm) {
      if (closed || ending || fatal || !pcm.length) return
      if (cur.state === 'ready' && now() - cur.opened >= sessionMs) rotate()
      const m = JSON.stringify({ realtimeInput: { audio: { data: b64(pcm), mimeType: mime } } })
      if (cur.state === 'ready') cur.ws.send(m)
      else cur.queue.push(m)
    },
    async end() {
      if (!ending && !closed) {
        ending = true
        for (const s of sessions) {
          if (s.state === 'ready') sendEnd(s)
          else if (s.state === 'connecting') s.endAsked = true
        }
      }
      await Promise.all(sessions.map((s) => s.done))
      // Сессии, открытые переподключением во время ожидания, — тоже.
      while (sessions.some((s) => s.state !== 'done')) await Promise.all(sessions.map((s) => s.done))
      if (fatal && !text()) throw fatal
      return text()
    },
    close() {
      if (closed) return
      closed = true
      for (const s of sessions) finishSession(s)
    },
  }
}

/** PCM16 моно LE → WAV (для пакетного прохода по звуку потока). */
export function pcmToWav(pcm: Uint8Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const v = new DataView(out.buffer)
  const str = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}
