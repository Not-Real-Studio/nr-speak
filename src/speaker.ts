/**
 * Speaker — сборка «голос → движок → звук → формат → кэш» поверх настроенных движков.
 * Один кусок (`synth`) — один запрос к движку; повтор того же куска — из кэша, без
 * синтеза. Ключ — `sha256(engine|voice|instruct|speed|text)`, файл — `<ключ>.<формат>`.
 * Длинный текст — последовательность кусков (`stream`): следующий синтезируется, пока
 * отдаётся текущий. Кэш и ffmpeg — инъекцией (`@notrealstudio/speak/node`).
 */

import type { CatalogVoice, EngineName, Engines, Resolved } from './catalog.js'
import { catalog, resolveVoice } from './catalog.js'
import type { FfmpegRun, Format } from './audio.js'
import { collect, concat, CONTENT_TYPE, convert, OUT_RATE, wavHeader } from './audio.js'

export interface SegmentCache {
  get(key: string): Promise<Uint8Array | undefined>
  set(key: string, data: Uint8Array): Promise<void>
}

export interface SpeakRequest {
  /** Голос: `vertex:Kore`, `Kore`, `edge:Svetlana`, пусто — по умолчанию. */
  voice?: string | undefined
  /** Явный движок (короткое имя голоса ищется только в нём). */
  engine?: string | undefined
  instruct?: string | undefined
  speed?: number | undefined
}

export interface SynthResult {
  data: Uint8Array
  contentType: string
  /** Из кэша — без синтеза. */
  cached: boolean
  key: string
  voice: Resolved
}

export interface SpeakerOpts {
  engines: Engines
  /** Голос для пустого `voice` (`vertex:Sulafat`). */
  defaultVoice?: string | undefined
  /** Избранные голоса каталога (`Sulafat, Leda, Enceladus`). */
  favorites?: readonly string[] | undefined
  cache?: SegmentCache | undefined
  ffmpeg?: FfmpegRun | undefined
}

export interface Speaker {
  readonly engines: Engines
  readonly defaultVoice: string | undefined
  /** Счётчики: синтезов и попаданий в кэш с момента создания. */
  readonly stats: { synth: number; hits: number }
  resolve(voice?: string, engine?: string): Promise<Resolved>
  voices(engine?: string): Promise<{ voices: CatalogVoice[]; errors: { engine: EngineName; error: string }[] }>
  /** Ключ кэша куска (без синтеза). */
  key(text: string, req: SpeakRequest, format: Format): Promise<{ key: string; voice: Resolved }>
  synth(text: string, req: SpeakRequest, format: Format, signal?: AbortSignal): Promise<SynthResult>
  /** Куски подряд одним потоком (mp3/opus — склейкой, wav — один заголовок + PCM). */
  stream(texts: readonly string[], req: SpeakRequest, format: Format, signal?: AbortSignal): AsyncGenerator<Uint8Array>
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** Ключ куска: движок, голос, тон, темп, текст. */
export const segmentKey = (engine: string, voice: string, instruct: string, speed: number, text: string): Promise<string> =>
  sha256([engine, voice, instruct, String(speed), text].join('|'))

export function createSpeaker(o: SpeakerOpts): Speaker {
  const stats = { synth: 0, hits: 0 }
  const speedOf = (req: SpeakRequest): number => {
    const s = req.speed ?? 1
    if (!Number.isFinite(s) || s < 0.25 || s > 4) throw new Error(`speak: темп ${req.speed} вне 0.25…4`)
    return s
  }
  const resolve = (voice?: string, engine?: string): Promise<Resolved> => resolveVoice(o.engines, voice, { engine, defaultVoice: o.defaultVoice })

  async function key(text: string, req: SpeakRequest, format: Format): Promise<{ key: string; voice: Resolved }> {
    const voice = await resolve(req.voice, req.engine)
    return { key: `${await segmentKey(voice.engine, voice.voice, req.instruct?.trim() ?? '', speedOf(req), text)}.${format}`, voice }
  }

  async function synth(text: string, req: SpeakRequest, format: Format, signal?: AbortSignal): Promise<SynthResult> {
    if (!text.trim()) throw new Error('speak: пустой текст')
    const { key: k, voice } = await key(text, req, format)
    const contentType = CONTENT_TYPE[format]
    const hit = await o.cache?.get(k)
    if (hit) {
      stats.hits++
      return { data: hit, contentType, cached: true, key: k, voice }
    }
    const engine = o.engines[voice.engine]!
    const speed = speedOf(req)
    stats.synth++
    const audio = await collect(
      engine.speak(
        text,
        voice.voice,
        {
          ...(req.instruct?.trim() ? { instruct: req.instruct.trim() } : {}),
          ...(engine.nativeSpeed && speed !== 1 ? { speed } : {}),
          format: format === 'mp3' ? 'mp3' : 'pcm',
        },
        signal,
      ),
    )
    const data = await convert(audio, format, { speed: engine.nativeSpeed ? 1 : speed, ffmpeg: o.ffmpeg })
    await o.cache?.set(k, data)
    return { data, contentType, cached: false, key: k, voice }
  }

  async function* stream(texts: readonly string[], req: SpeakRequest, format: Format, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    if (!texts.length) throw new Error('speak: пустой текст')
    // wav: один заголовок на поток, куски — сырым PCM.
    const part: Format = format === 'wav' ? 'pcm' : format
    if (format === 'wav') yield wavHeader(OUT_RATE)
    let next: Promise<SynthResult> | null = synth(texts[0]!, req, part, signal)
    for (let i = 0; i < texts.length; i++) {
      const cur: Promise<SynthResult> = next!
      next = i + 1 < texts.length ? cur.then(() => synth(texts[i + 1]!, req, part, signal)) : null
      // Ошибку следующего куска увидит его очередь, не необработанный reject.
      next?.catch(() => {})
      const r = await cur
      if (signal?.aborted) return
      yield r.data
    }
  }

  return {
    engines: o.engines,
    defaultVoice: o.defaultVoice,
    stats,
    resolve,
    voices: (engine) => catalog(o.engines, { engine, favorites: o.favorites }),
    key,
    synth,
    stream,
  }
}

/** Куски одним буфером (CLI `--out`). */
export async function streamAll(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const p of gen) parts.push(p)
  return concat(parts)
}
