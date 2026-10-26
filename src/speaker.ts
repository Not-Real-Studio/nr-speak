/**
 * Speaker — сборка «голос → движок → звук → формат → кэш» поверх настроенных движков.
 * Один кусок (`synth`) — один запрос к движку; повтор того же куска — из кэша, без
 * синтеза. Ключ — `sha256(engine|voice|instruct|speed|text)`, файл — `<ключ>.<формат>`.
 * Длинный текст — последовательность кусков (`stream`): кусок не из кэша отдаётся по мере
 * синтеза — кадры движка (PCM Gemini) идут в ffmpeg-трубу и наружу сразу (первый звук до
 * конца синтеза), параллельно копятся и по завершении ложатся в кэш. Кэш и ffmpeg —
 * инъекцией (`@notrealstudio/speak/node`).
 */

import type { CatalogVoice, EngineName, Engines, Resolved } from './catalog.js'
import { catalog, resolveVoice } from './catalog.js'
import type { FfmpegPipe, FfmpegRun, Format } from './audio.js'
import { collect, concat, CONTENT_TYPE, convert, ffmpegArgs, OUT_RATE, wavHeader } from './audio.js'
import type { AudioChunk } from './types.js'
import { isMp3, isPcm, rateOf } from './types.js'

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
  /** ffmpeg трубой — поток куска по мере синтеза; нет — кусок отдаётся целиком после синтеза. */
  ffmpegPipe?: FfmpegPipe | undefined
  /**
   * Хедж синтеза куска, мс (DEV-419): кусок не готов за это время — второй такой же запрос тем же
   * движком и голосом, кто первый — тот и отдан, второй отменяется. Выбросы Vertex (26–52 с при
   * p50 4 с) — зависший запрос, а не долгий синтез. 0 — без хеджа; по умолчанию 8000.
   */
  hedgeMs?: number | undefined
  /**
   * Коллекция голосов (voice-lab-spec §2): `voice: "@<slug>"` → движок, голос и подача по умолчанию
   * из `envs/voices/<slug>.mdz` (Node — `fileCollection`). Нет — `@…` падает понятной ошибкой.
   */
  collection?: VoiceCollection | undefined
  /** Хедж сработал (куда и чем кончился) — в лог сервера. */
  onHedge?: ((e: { key: string; engine: string; winner: 'first' | 'hedge' | 'none'; ms: number }) => void) | undefined
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
  /**
   * Куски подряд одним потоком (mp3/opus — склейкой, wav — один заголовок + PCM). Кусок не из
   * кэша — по мере синтеза (`ffmpegPipe`), ошибка до первого байта — исключением из первого `next()`.
   */
  stream(texts: readonly string[], req: SpeakRequest, format: Format, signal?: AbortSignal): AsyncGenerator<Uint8Array>
}

/** Голос коллекции — то, что нужно синтезу (остальные поля файла — для стенда). */
export interface CollectionVoice {
  slug: string
  engine: string
  voice: string
  /** Подача по умолчанию (`$style`): идёт в `instruct`, если запрос свою не задал. */
  style?: string | undefined
}

export interface VoiceCollection {
  get(slug: string): Promise<CollectionVoice | undefined>
}

/** `@slug` → запрос с движком и голосом коллекции; остальное — как есть. */
export async function expandCollection(req: SpeakRequest, collection: VoiceCollection | undefined): Promise<SpeakRequest> {
  const v = req.voice?.trim()
  if (!v?.startsWith('@')) return req
  const slug = v.slice(1)
  if (!collection) throw new Error(`speak: голос «${v}» — из коллекции, а коллекция не подключена`)
  const hit = await collection.get(slug)
  if (!hit) throw new Error(`speak: в коллекции нет голоса «${slug}» (envs/voices/${slug}.mdz)`)
  const { engine: _engine, ...rest } = req
  return { ...rest, voice: `${hit.engine}:${hit.voice}`, ...(!req.instruct?.trim() && hit.style ? { instruct: hit.style } : {}) }
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
  const resolve = async (voice?: string, engine?: string): Promise<Resolved> => {
    const r = await expandCollection({ voice, engine }, o.collection)
    return resolveVoice(o.engines, r.voice, { engine: r.engine, defaultVoice: o.defaultVoice })
  }

  async function key(text: string, req0: SpeakRequest, format: Format): Promise<{ key: string; voice: Resolved }> {
    const req = await expandCollection(req0, o.collection)
    const voice = await resolve(req.voice, req.engine)
    return { key: `${await segmentKey(voice.engine, voice.voice, req.instruct?.trim() ?? '', speedOf(req), text)}.${format}`, voice }
  }

  // Один и тот же кусок разом (клиент + предзагрузка) — один синтез.
  const inflight = new Map<string, Promise<SynthResult>>()

  async function synth(text: string, req0: SpeakRequest, format: Format, signal?: AbortSignal): Promise<SynthResult> {
    if (!text.trim()) throw new Error('speak: пустой текст')
    const req = await expandCollection(req0, o.collection)
    const { key: k, voice } = await key(text, req, format)
    const running = inflight.get(k)
    if (running) return running
    const p = synthOnce(text, req, format, k, voice, signal)
    inflight.set(k, p)
    try {
      return await p
    } finally {
      inflight.delete(k)
    }
  }

  async function synthOnce(text: string, req: SpeakRequest, format: Format, k: string, voice: Resolved, signal?: AbortSignal): Promise<SynthResult> {
    const contentType = CONTENT_TYPE[format]
    const hit = await o.cache?.get(k)
    if (hit) {
      stats.hits++
      return { data: hit, contentType, cached: true, key: k, voice }
    }
    const engine = o.engines[voice.engine]!
    const speed = speedOf(req)
    stats.synth++
    const once = (sig?: AbortSignal) =>
      collect(
        engine.speak(
          text,
          voice.voice,
          {
            ...(req.instruct?.trim() ? { instruct: req.instruct.trim() } : {}),
            ...(engine.nativeSpeed && speed !== 1 ? { speed } : {}),
            format: format === 'mp3' ? 'mp3' : 'pcm',
          },
          sig,
        ),
      )
    const audio = await hedged(once, o.hedgeMs ?? 8000, signal, (winner, ms) => o.onHedge?.({ key: k, engine: voice.engine, winner, ms }))
    const data = await convert(audio, format, { speed: engine.nativeSpeed ? 1 : speed, ffmpeg: o.ffmpeg })
    await o.cache?.set(k, data)
    return { data, contentType, cached: false, key: k, voice }
  }

  /** Кусок потоком: кэш/идущий синтез — целиком; иначе кадры движка → (ffmpeg-труба) → наружу и в кэш. */
  async function* live(text: string, req: SpeakRequest, format: Format, signal?: AbortSignal, onFirst: () => void = () => {}): AsyncGenerator<Uint8Array> {
    if (!text.trim()) throw new Error('speak: пустой текст')
    const { key: k, voice } = await key(text, req, format)
    const running = inflight.get(k)
    if (running) {
      const r = await running
      onFirst()
      return yield r.data
    }
    const hit = await o.cache?.get(k)
    if (hit) {
      stats.hits++
      onFirst()
      return yield hit
    }
    const engine = o.engines[voice.engine]!
    const speed = speedOf(req)
    const tempo = engine.nativeSpeed ? 1 : speed
    stats.synth++
    const it = engine
      .speak(
        text,
        voice.voice,
        {
          ...(req.instruct?.trim() ? { instruct: req.instruct.trim() } : {}),
          ...(engine.nativeSpeed && speed !== 1 ? { speed } : {}),
          format: format === 'mp3' ? 'mp3' : 'pcm',
        },
        signal,
      )
      [Symbol.asyncIterator]()
    // Первый кадр — до первого байта наружу: ошибка провайдера/резолва уходит исключением.
    const first = await it.next()
    if (first.done) throw new Error('speak: провайдер не прислал звука')
    onFirst()
    const mime = first.value.mime
    const parts: Uint8Array[] = []
    let settle: (r: SynthResult | PromiseLike<SynthResult>) => void = () => {}
    let fail: (e: unknown) => void = () => {}
    const done = new Promise<SynthResult>((res, rej) => ((settle = res), (fail = rej)))
    done.catch(() => {})
    inflight.set(k, done)
    let complete = false
    try {
      const direct = tempo === 1 && ((format === 'mp3' && isMp3(mime)) || (format === 'pcm' && isPcm(mime) && rateOf(mime) === OUT_RATE))
      if (direct) {
        for (let n: IteratorResult<AudioChunk> = first; !n.done; n = await it.next()) {
          parts.push(n.value.data)
          yield n.value.data
        }
      } else if (o.ffmpegPipe && format !== 'wav') {
        const proc = o.ffmpegPipe(ffmpegArgs(mime, format, tempo, true))
        let feedErr: unknown
        let stopped = false
        const feeding = (async () => {
          try {
            for (let n: IteratorResult<AudioChunk> = first; !n.done && !stopped; n = await it.next()) await proc.write(n.value.data)
            proc.end()
          } catch (err) {
            feedErr = err
            proc.kill()
          }
        })()
        let drained = false
        try {
          for await (const b of proc.output) {
            parts.push(b)
            yield b
          }
          drained = true
        } finally {
          // Ушли раньше конца (клиент закрыл поток, ошибка) — ffmpeg и подачу оборвать.
          if (!drained) {
            stopped = true
            proc.kill()
          }
        }
        await feeding
        if (feedErr !== undefined) throw feedErr
      } else {
        // Без трубы — как раньше: собрать, перекодировать, отдать целиком.
        const rest: AudioChunk[] = [first.value]
        for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value)
        const data = await convert({ data: concat(rest.map((c) => c.data)), mime }, format, { speed: tempo, ffmpeg: o.ffmpeg })
        parts.push(data)
        yield data
      }
      if (signal?.aborted) throw new Error('speak: синтез отменён')
      const data = concat(parts)
      complete = true
      await o.cache?.set(k, data)
      settle({ data, contentType: CONTENT_TYPE[format], cached: false, key: k, voice })
    } catch (err) {
      fail(err)
      throw err
    } finally {
      // Клиент ушёл посреди куска — движок не дослушиваем, в кэш не пишем.
      if (!complete) {
        fail(new Error('speak: поток куска оборван'))
        await it.return?.(undefined)?.catch?.(() => {})
      }
      if (inflight.get(k) === done) inflight.delete(k)
    }
  }

  async function* stream(texts: readonly string[], req0: SpeakRequest, format: Format, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    if (!texts.length) throw new Error('speak: пустой текст')
    const req = await expandCollection(req0, o.collection)
    // wav: один заголовок на поток, куски — сырым PCM.
    const part: Format = format === 'wav' ? 'pcm' : format
    let started = false
    let ahead: Promise<SynthResult> | undefined
    for (let i = 0; i < texts.length; i++) {
      // Следующий кусок — заранее, как только у текущего пошёл звук (не в споре за первый байт).
      let next: Promise<SynthResult> | undefined
      const prefetch = (): void => {
        const t = texts[i + 1]
        if (t === undefined || signal?.aborted || next) return
        next = synth(t, req, part, signal)
        next.catch(() => {})
      }
      const parts: AsyncIterable<Uint8Array> = ahead
        ? (async function* (p: Promise<SynthResult>) {
            const r = await p
            prefetch()
            yield r.data
          })(ahead)
        : live(texts[i]!, req, part, signal, prefetch)
      for await (const b of parts) {
        if (!started && format === 'wav') yield wavHeader(OUT_RATE)
        started = true
        yield b
      }
      if (signal?.aborted) return
      ahead = next
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

/**
 * `run` с хеджем: не кончился за `ms` — второй такой же запуск; первый успешный — результат,
 * остальные отменяются. Оба упали — первая по времени ошибка. `ms <= 0` — просто `run`.
 */
export async function hedged<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  signal?: AbortSignal,
  onHedge?: (winner: 'first' | 'hedge' | 'none', ms: number) => void,
): Promise<T> {
  if (!(ms > 0)) return run(signal ?? new AbortController().signal)
  const t0 = Date.now()
  const ctls = [new AbortController(), new AbortController()]
  const stopAll = (): void => ctls.forEach((c) => c.abort())
  signal?.addEventListener('abort', stopAll, { once: true })
  try {
    return await new Promise<T>((resolve, reject) => {
      let failed = 0
      let started = 1
      let firstErr: unknown
      let hedge: ReturnType<typeof setTimeout> | undefined
      const launch = (n: 0 | 1): void => {
        run(ctls[n]!.signal).then(
          (v) => {
            clearTimeout(hedge)
            if (started > 1) onHedge?.(n === 0 ? 'first' : 'hedge', Date.now() - t0)
            ctls[1 - n]!.abort()
            resolve(v)
          },
          (err: unknown) => {
            if (failed === 0) firstErr = err
            failed++
            if (n === 0 && started === 1) {
              clearTimeout(hedge)
              return reject(err)
            }
            if (failed >= started) {
              onHedge?.('none', Date.now() - t0)
              reject(firstErr)
            }
          },
        )
      }
      launch(0)
      hedge = setTimeout(() => {
        if (signal?.aborted) return
        started = 2
        launch(1)
      }, ms)
    })
  } finally {
    signal?.removeEventListener('abort', stopAll)
  }
}
