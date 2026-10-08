/**
 * Контракт движка озвучки (`TtsEngine`, перенос из `nrchat/plugins/voice/engine.ts`) и
 * общие типы. Новое против nrchat — только необязательные поля: `SpeakOpts.speed`,
 * `SpeakOpts.format`, `TtsEngine.nativeSpeed` — старые вызовы их не видят.
 */

export interface VoiceInfo {
  id: string
  /** `prompted` — свой (дизайн проекта, в счёт лимита), `prebuilt` — каталог провайдера. */
  type?: string
  name?: string
  gender?: string
  lang?: string
  /** Описание дизайна (prompted) — по нему видно, чей это голос. */
  design?: string
  expires?: string
}

export interface DesignSpec {
  /** Описание голоса композитора (`Male voice, 40s, …`). */
  design: string
  gender?: string | undefined
  /** BCP-47 (`ru-RU`); пусто — `en-US`. */
  lang?: string | undefined
  /** Подпись голоса у провайдера (кто это), не ключ кэша. */
  name?: string | undefined
}

export interface SpeakOpts {
  /** Тон реплики (`angrily`, `in a whisper`) — `speech_metadata.style` у Gemini, `instructions` у OpenAI. */
  instruct?: string | undefined
  lang?: string | undefined
  /** Темп 0.25…4 (1 — как есть). Движок без `nativeSpeed` его не видит — темп ставит перекодировщик. */
  speed?: number | undefined
  /** Желаемый формат: движок, умеющий его сам (Edge, Chirp, OpenAI — mp3), отдаёт его без перекодирования. */
  format?: 'mp3' | 'pcm' | undefined
}

/**
 * Кадр звука; `mime` — как у провайдера: `audio/l16; rate=24000; channels=1` (сырой PCM s16le),
 * `audio/wav` (с заголовком), `audio/mpeg` (mp3).
 */
export interface AudioChunk {
  data: Uint8Array
  mime: string
}

export interface TtsEngine {
  /** Какой движок (`gemini` | `vertex` | `routed` | `chirp` | `edge` | `openai`). */
  readonly kind?: string
  /** Лимит своих голосов у провайдера: 200 у Gemini, 0 у остальных (своих нет). */
  readonly limit?: number
  /** Движок сам держит `speed` (иначе темп — забота перекодировщика). */
  readonly nativeSpeed?: boolean
  /** Свои голоса проекта (в счёт лимита); `prebuilt` — ещё и каталог провайдера. */
  voices(opts?: { prebuilt?: boolean }): Promise<VoiceInfo[]>
  design(spec: DesignSpec): Promise<{ id: string; cached: boolean }>
  speak(text: string, voiceId: string, opts: SpeakOpts, signal?: AbortSignal): AsyncIterable<AudioChunk>
}

/** Кэш `(lang|design) → id`: у сервиса, не у движка. */
export interface VoiceCache {
  get(key: string): string | undefined
  set(key: string, id: string): void
}

/** Ошибка с HTTP-статусом провайдера (429, 403, …). */
export type StatusError = Error & { status?: number }

export function statusError(message: string, status: number): StatusError {
  const err: StatusError = new Error(message)
  err.status = status
  return err
}

/** Ожидание с отменой: сигнал прерывает ожидание, не бросает. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** Частота из mime провайдера (`audio/l16; rate=24000; channels=1`); нет — 24 кГц. */
export const rateOf = (mime: string): number => Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000)

export const isPcm = (mime: string): boolean => /audio\/(l16|pcm)/i.test(mime)
export const isMp3 = (mime: string): boolean => /audio\/(mpeg|mp3)/i.test(mime)
export const isWav = (mime: string): boolean => /audio\/(wav|x-wav|wave)/i.test(mime)
