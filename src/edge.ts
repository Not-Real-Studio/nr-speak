/**
 * Microsoft Edge read-aloud (бесплатно, без ключа): голоса `ru-RU-SvetlanaNeural`,
 * `ru-RU-DmitryNeural`, … Провод — WebSocket Edge; клиент — `msedge-tts` (живой, токен
 * Sec-MS-GEC держит он), грузится лениво — кто Edge не зовёт, его не тянет. Отдаёт mp3
 * 24 кГц как есть (без перекодирования).
 *
 * С 12.2025 Microsoft режет частые запросы по IP (403): запросы строго по одному
 * (`concurrency 1`), на 403 — пауза и повтор.
 */

import type { AudioChunk, SpeakOpts, TtsEngine, VoiceInfo } from './types.js'
import { abortableSleep } from './types.js'

/** Минимальный клиент Edge: тесты подменяют его моком. */
export interface EdgeClient {
  synth(ssmlText: string, voice: string, opts: { rate: string }, signal?: AbortSignal): AsyncIterable<Uint8Array>
  voices(): Promise<{ ShortName: string; Gender?: string; Locale?: string }[]>
}

export interface EdgeOpts {
  client?: EdgeClient | undefined
  defaultVoice?: string | undefined
  /** Каталог — только этих языков (по умолчанию `ru-RU`); пусто — все. */
  langs?: readonly string[] | undefined
  /** Повторы на 403 и паузы перед ними, мс (по умолчанию 5 с, 20 с). */
  backoff?: readonly number[] | undefined
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
}

export const EDGE_DEFAULT_VOICE = 'ru-RU-SvetlanaNeural'

/** Текст в SSML: клиент вставляет его в `<prosody>` как есть. */
export const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Темп 1.2 → `+20%`, 0.8 → `-20%`. */
export function edgeRate(speed: number | undefined): string {
  const pct = Math.round(((speed ?? 1) - 1) * 100)
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

/** 403 / «IP restricted» — режет Microsoft, имеет смысл переждать. */
export const isEdgeBlocked = (err: unknown): boolean => /403|forbidden|restricted/i.test(String((err as Error)?.message ?? err))

/** Клиент по умолчанию — `msedge-tts`: новое соединение на запрос (у Edge оно одноразовое по сути). */
export function msEdgeClient(): EdgeClient {
  const lib = async () => import('msedge-tts')
  return {
    async *synth(text, voice, opts, signal) {
      const { MsEdgeTTS, OUTPUT_FORMAT } = await lib()
      const tts = new MsEdgeTTS()
      try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
        const { audioStream } = tts.toStream(text, { rate: opts.rate })
        signal?.addEventListener('abort', () => audioStream.destroy(), { once: true })
        for await (const chunk of audioStream) yield new Uint8Array(chunk as Buffer)
      } finally {
        tts.close()
      }
    },
    async voices() {
      const { MsEdgeTTS } = await lib()
      const tts = new MsEdgeTTS()
      try {
        return await tts.getVoices()
      } finally {
        tts.close()
      }
    },
  }
}

export function createEdgeEngine(o: EdgeOpts = {}): TtsEngine {
  const client = o.client ?? msEdgeClient()
  const backoff = o.backoff ?? [5_000, 20_000]
  const sleep = o.sleep ?? abortableSleep
  const langs = o.langs ?? ['ru-RU']
  // Очередь: следующий запрос стартует, когда предыдущий отдал весь звук.
  let tail: Promise<void> = Promise.resolve()
  let catalog: Promise<VoiceInfo[]> | null = null

  async function* run(text: string, voice: string, opts: SpeakOpts, signal?: AbortSignal): AsyncGenerator<AudioChunk> {
    for (let attempt = 0; ; attempt++) {
      let got = false
      try {
        for await (const data of client.synth(xmlEscape(text), voice, { rate: edgeRate(opts.speed) }, signal)) {
          got = true
          yield { data, mime: 'audio/mpeg' }
        }
        if (!got) throw new Error('edge.speak: провайдер не прислал звука')
        return
      } catch (err) {
        // Повтор — только пока звук не начал уходить потребителю.
        if (got || !isEdgeBlocked(err) || attempt >= backoff.length || signal?.aborted) {
          const msg = String((err as Error)?.message ?? err)
          throw new Error(isEdgeBlocked(err) ? `edge.speak: Microsoft режет запросы с этого IP (403): ${msg}` : msg.startsWith('edge.') ? msg : `edge.speak: ${msg}`)
        }
        await sleep(backoff[attempt]!, signal)
      }
    }
  }

  return {
    kind: 'edge',
    limit: 0,
    nativeSpeed: true,
    voices() {
      catalog ??= client.voices().then((list) =>
        list
          .filter((v) => !langs.length || langs.includes(v.Locale ?? ''))
          .map((v) => ({ id: v.ShortName, type: 'prebuilt', name: v.ShortName, ...(v.Locale ? { lang: v.Locale } : {}), ...(v.Gender ? { gender: v.Gender.toLowerCase() } : {}) })),
      )
      catalog.catch(() => {
        catalog = null
      })
      return catalog
    },
    async design() {
      throw new Error('edge.design: у Edge своих голосов нет')
    },
    async *speak(text, voiceId, opts, signal) {
      const voice = voiceId || o.defaultVoice || EDGE_DEFAULT_VOICE
      let release!: () => void
      const mine = new Promise<void>((r) => (release = r))
      const before = tail
      tail = tail.then(() => mine)
      try {
        await before
        yield* run(text, voice, opts, signal)
      } finally {
        release()
      }
    },
  }
}
