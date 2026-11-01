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
import type { AudioChunk, SpeakOpts, TtsEngine } from './types.js'
import { isMp3, isPcm, rateOf } from './types.js'
import { createFallbackEngine } from './local.js'
import { speechText } from './normalize.js'
import type { Pick, PrimaryRun } from './race.js'
import { pickFirst, startPrimary } from './race.js'

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
  /**
   * Запасные голоса по порядку (`$fallback` голоса коллекции, DEV-547): основной не дал первого
   * звука за `chainFirstAudioMs` (или упал) — та же фраза следующим. Звук запасного не кэшируется
   * под ключом основного.
   */
  fallback?: readonly string[] | undefined
  /**
   * Кусок для живого слушателя (DEV-577): `now` — нужен для игры сейчас, идёт гонка с параллельным
   * голосом (`SpeakerOpts.parallel`); `ahead` — предзагрузка: только основной голос, гонка начнётся,
   * когда тот же кусок попросят с `now`. Нет поля — без гонки (рендер книг, CLI, стенд голосов).
   */
  play?: 'now' | 'ahead' | undefined
}

/** Параллельный голос (DEV-577): страховка от молчания основного на каждом куске. */
export interface ParallelOpts {
  /** Голос-страховка (`@sulafat-local`): его `$fallback` не действует — страховке запасной не нужен. */
  voice: string
  /** Первый звук основного — за столько мс от момента, когда кусок нужен, иначе играет параллельный (по умолчанию 1000). */
  firstAudioMs?: number | undefined
  /** Какие голоса страхуются (`vertex:Sulafat`); нет — только голос по умолчанию: клон подходит своему оригиналу. */
  for?: readonly string[] | undefined
  /** Основной, проигравший или предзагруженный, живёт не дольше (по умолчанию 120 000). */
  primaryMaxMs?: number | undefined
}

/** Журнал гонки: кто сыграл кусок и первый звук обоих. */
export interface PieceEvent {
  key: string
  /** Основной голос (`vertex:Sulafat`). */
  voice: string
  played: 'primary' | 'parallel' | 'cache'
  /** Какой движок дал звук (`omnivoice`, запасной `pocket`); из кэша — нет. */
  engine?: string | undefined
  reason?: string | undefined
  /** Мс от момента «нужен» до звука, отданного наружу. */
  firstMs: number
  /** Первый звук основного от его старта; нет — упал. */
  primaryMs?: number | undefined
  /** Основной начат заранее, за столько мс до того, как кусок понадобился. */
  aheadMs?: number | undefined
  /** Первый звук параллельного от момента «нужен». */
  parallelMs?: number | undefined
}

export interface SynthResult {
  data: Uint8Array
  contentType: string
  /** Из кэша — без синтеза. */
  cached: boolean
  key: string
  voice: Resolved
}

/** Основной голос куска: один синтез на всех, кто его просит. */
interface Run {
  run: PrimaryRun<SynthResult>
  at: number
  engine: TtsEngine
  job: string
  /** Кусок нужен для игры (не только предзагрузка). */
  now: boolean
  clients: number
}

/** Ждать промис, пока клиент не ушёл. */
function untilAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const off = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      off()
      reject(new Error('speak: синтез отменён'))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then((v) => (off(), resolve(v)), (e: unknown) => (off(), reject(e)))
  })
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
  /** Цепочка `fallback`: первый звук основного — за столько мс, иначе следующий голос (по умолчанию 1500). */
  chainFirstAudioMs?: number | undefined
  /** То же для второго и дальше звена (облако думает дольше локального; по умолчанию 20 000 — переход по ошибке). */
  chainNextAudioMs?: number | undefined
  /** Гонка с параллельным голосом на кусках `play` (DEV-577); нет — без гонки. */
  parallel?: ParallelOpts | undefined
  /** Кусок сыгран в гонке — в лог сервера. Приходит, когда известен первый звук основного или его отказ. */
  onPiece?: ((e: PieceEvent) => void) | undefined
  /** Цепочка перешла на запасной голос — в лог сервера. */
  onChainFallback?: ((e: { voice: string; reason: string }) => void) | undefined
  /** Хедж сработал (куда и чем кончился) — в лог сервера. */
  onHedge?: ((e: { key: string; engine: string; winner: 'first' | 'hedge' | 'none'; ms: number }) => void) | undefined
}

export interface Speaker {
  readonly engines: Engines
  readonly defaultVoice: string | undefined
  /** Счётчики: синтезов и попаданий в кэш с момента создания. */
  readonly stats: { synth: number; hits: number; primary: number; parallel: number }
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
  /** Запасные голоса по порядку (`$fallback`, DEV-547): `openai:vertex:Sulafat, say:Milena`. */
  fallback?: readonly string[] | undefined
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
  return {
    ...rest,
    voice: `${hit.engine}:${hit.voice}`,
    ...(!req.instruct?.trim() && hit.style ? { instruct: hit.style } : {}),
    ...(!req.fallback?.length && hit.fallback?.length ? { fallback: hit.fallback } : {}),
  }
}

/** Движок с прибитым голосом: цепочка зовёт звенья одним `speak`, а голоса у них разные. */
function pinned(engine: TtsEngine, voice: string, kind: string): TtsEngine {
  return {
    kind,
    limit: engine.limit ?? 0,
    ...(engine.nativeSpeed ? { nativeSpeed: true } : {}),
    voices: (opts) => engine.voices(opts),
    design: (spec) => engine.design(spec),
    speak: (text: string, _voice: string, opts: SpeakOpts, signal?: AbortSignal) => engine.speak(text, voice, opts, signal),
  }
}

/** Движки со своей чисткой текста: одна точка на все пути и голоса, ключ кэша не меняется. */
function plainEngines(engines: Engines): Engines {
  const out: Engines = {}
  for (const [name, e] of Object.entries(engines)) {
    if (!e) continue
    out[name as EngineName] = {
      ...e,
      async *speak(text: string, voice: string, opts: SpeakOpts, signal?: AbortSignal) {
        const clean = speechText(text)
        if (clean) yield* e.speak(clean, voice, opts, signal)
      },
    }
  }
  return out
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** Ключ куска: движок, голос, тон, темп, текст. */
export const segmentKey = (engine: string, voice: string, instruct: string, speed: number, text: string): Promise<string> =>
  sha256([engine, voice, instruct, String(speed), text].join('|'))

export function createSpeaker(o: SpeakerOpts): Speaker {
  const engines = plainEngines(o.engines)
  const stats = { synth: 0, hits: 0, primary: 0, parallel: 0 }
  const speedOf = (req: SpeakRequest): number => {
    const s = req.speed ?? 1
    if (!Number.isFinite(s) || s < 0.25 || s > 4) throw new Error(`speak: темп ${req.speed} вне 0.25…4`)
    return s
  }
  const resolve = async (voice?: string, engine?: string): Promise<Resolved> => {
    // Голос по умолчанию из коллекции (`$voice: @slug`, DEV-520) разворачивается так же, как голос запроса.
    const own = voice?.trim() || (!engine && o.defaultVoice?.trim().startsWith('@') ? o.defaultVoice.trim() : undefined)
    const r = await expandCollection({ voice: own, engine }, o.collection)
    return resolveVoice(engines, r.voice, { engine: r.engine, defaultVoice: o.defaultVoice })
  }

  // Цепочки голосов (`fallback`) — по одной на набор: в звене живёт пропуск упавшего (`cooldownMs`).
  const chains = new Map<string, Promise<TtsEngine>>()
  const chainOf = (voice: Resolved, fallback: readonly string[]): Promise<TtsEngine> => {
    const id = [`${voice.engine}:${voice.voice}`, ...fallback].join('|')
    let p = chains.get(id)
    if (!p) {
      p = (async () => {
        const links: { engine: TtsEngine; name: string }[] = [{ engine: pinned(engines[voice.engine]!, voice.voice, voice.engine), name: `${voice.engine}:${voice.voice}` }]
        for (const v of fallback) {
          try {
            const r = await resolve(v)
            const name = `${r.engine}:${r.voice}`
            if (links.some((l) => l.name === name)) continue
            links.push({ engine: pinned(engines[r.engine]!, r.voice, r.engine), name })
          } catch {
            // Запасной не настроен на этом сервере (нет движка) — звено пропускается.
          }
        }
        let acc = links[links.length - 1]!.engine
        for (let i = links.length - 2; i >= 0; i--) {
          const backup = links[i + 1]!.name
          acc = createFallbackEngine(links[i]!.engine, acc, {
            firstAudioMs: i === 0 ? (o.chainFirstAudioMs ?? 1500) : (o.chainNextAudioMs ?? 20_000),
            backupName: backup,
            onFallback: (e) => o.onChainFallback?.({ voice: backup, reason: e.reason }),
          })
        }
        return acc
      })()
      p.catch(() => chains.delete(id))
      chains.set(id, p)
    }
    return p
  }
  const engineFor = (voice: Resolved, req: SpeakRequest): Promise<TtsEngine> | TtsEngine =>
    req.fallback?.length ? chainOf(voice, req.fallback) : engines[voice.engine]!

  // Гонка: голос-страховка без своей цепочки и список страхуемых голосов — один раз на сервер.
  const raced = (async (): Promise<{ engine: TtsEngine; voice: string; insured: Set<string> } | undefined> => {
    const p = o.parallel
    if (!p?.voice.trim()) return undefined
    try {
      const r = await resolve(p.voice)
      const insured = new Set<string>()
      for (const v of p.for?.length ? p.for : [o.defaultVoice ?? '']) {
        const m = await resolve(v || undefined)
        insured.add(`${m.engine}:${m.voice}`)
      }
      return { engine: engines[r.engine]!, voice: r.voice, insured }
    } catch {
      // Голос-страховка не настроен на этом сервере — живём без гонки.
      return undefined
    }
  })()
  const raceFor = async (voice: Resolved, req: SpeakRequest): Promise<{ engine: TtsEngine; voice: string } | undefined> => {
    if (!req.play) return undefined
    const r = await raced
    return r?.insured.has(`${voice.engine}:${voice.voice}`) ? r : undefined
  }

  async function key(text: string, req0: SpeakRequest, format: Format): Promise<{ key: string; voice: Resolved }> {
    const req = await expandCollection(req0, o.collection)
    const voice = await resolve(req.voice, req.engine)
    return { key: `${await segmentKey(voice.engine, voice.voice, req.instruct?.trim() ?? '', speedOf(req), text)}.${format}`, voice }
  }

  // Один и тот же кусок разом (клиент + предзагрузка) — один синтез.
  const inflight = new Map<string, Promise<SynthResult>>()
  // Основные голоса кусков гонки: живут мимо клиента и дописывают звук в кэш.
  const runs = new Map<string, Run>()
  let jobs = 0

  // Локальный движок с очередью: кусок всегда один общий синтез, просьбы подключаются к нему (DEV-581).
  const queued = async (voice: Resolved, req: SpeakRequest): Promise<boolean> => !!req.play && !!(await engineFor(voice, req)).promote

  /** Кусок понадобился для игры: идёт вперёд очереди, порог первого звука считается отсюда. */
  const promote = (e: Run): void => {
    if (e.now) return
    e.now = true
    e.engine.promote?.(e.job)
  }

  /** Клиент держит кусок: все ушли — синтез снимается, кроме гонки (там основной пишет кэш). */
  function hold(e: Run, signal?: AbortSignal): () => void {
    e.clients++
    let gone = false
    const leave = (): void => {
      if (gone) return
      gone = true
      e.clients--
      signal?.removeEventListener('abort', leave)
      if (e.clients === 0 && signal?.aborted && e.engine.promote) e.run.cancel()
    }
    signal?.addEventListener('abort', leave, { once: true })
    if (signal?.aborted) leave()
    return leave
  }

  const speakOpts = (engine: TtsEngine, req: SpeakRequest, format: Format): SpeakOpts => {
    const speed = speedOf(req)
    return {
      ...(req.instruct?.trim() ? { instruct: req.instruct.trim() } : {}),
      ...(engine.nativeSpeed && speed !== 1 ? { speed } : {}),
      format: format === 'mp3' ? 'mp3' : 'pcm',
    }
  }

  async function primaryOf(text: string, req: SpeakRequest, format: Format, k: string, voice: Resolved): Promise<Run> {
    const had = runs.get(k)
    if (had && !had.run.failed()) return had
    const engine = await engineFor(voice, req)
    const again = runs.get(k)
    if (again && !again.run.failed()) return again
    const speed = speedOf(req)
    stats.synth++
    const job = `${k.slice(0, 16)}-${++jobs}`
    const queue: SpeakOpts = engine.promote ? { job, priority: req.play === 'ahead' ? 'ahead' : 'now' } : {}
    const run = startPrimary<SynthResult>(
      (sig) => engine.speak(text, voice.voice, { ...speakOpts(engine, req, format), ...queue }, sig),
      async (frames) => {
        const mime = frames[0]!.mime
        const data = await convert({ data: concat(frames.map((c) => c.data)), mime }, format, { speed: engine.nativeSpeed ? 1 : speed, ffmpeg: o.ffmpeg })
        if (!frames[0]!.fallback) await o.cache?.set(k, data)
        return { data, contentType: CONTENT_TYPE[format], cached: false, key: k, voice }
      },
      o.parallel?.primaryMaxMs ?? 120_000,
    )
    const entry: Run = { run, at: Date.now(), engine, job, now: req.play !== 'ahead', clients: 0 }
    runs.set(k, entry)
    inflight.set(k, run.done)
    const clear = (): void => {
      if (runs.get(k) === entry) runs.delete(k)
      if (inflight.get(k) === run.done) inflight.delete(k)
    }
    run.done.then(clear, clear)
    // Упавший — сразу из таблицы: следующая просьба запускает основной заново.
    run.first.catch(clear)
    return entry
  }

  async function synth(text: string, req0: SpeakRequest, format: Format, signal?: AbortSignal): Promise<SynthResult> {
    if (!text.trim()) throw new Error('speak: пустой текст')
    const req = await expandCollection(req0, o.collection)
    const { key: k, voice } = await key(text, req, format)
    if ((await raceFor(voice, req)) || (await queued(voice, req))) {
      // Целым куском гонки нет: предзагрузка копит основной, потоком играет `live`.
      const hit = await o.cache?.get(k)
      if (hit) {
        stats.hits++
        return { data: hit, contentType: CONTENT_TYPE[format], cached: true, key: k, voice }
      }
      return (await primaryOf(text, req, format, k, voice)).run.done
    }
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
    const engine = await engineFor(voice, req)
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
    // Звук запасного движка — не под ключом основного (DEV-520).
    if (!audio.fallback) await o.cache?.set(k, data)
    return { data, contentType, cached: false, key: k, voice }
  }

  /** Кадры движка → (ffmpeg-труба) → наружу; `parts` копит отданное. */
  async function* encoded(head: AudioChunk, it: AsyncIterator<AudioChunk>, tempo: number, format: Format, parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
    const mime = head.mime
    const first: IteratorResult<AudioChunk> = { done: false, value: head }
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
      const rest: AudioChunk[] = [head]
      for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value)
      const data = await convert({ data: concat(rest.map((c) => c.data)), mime }, format, { speed: tempo, ffmpeg: o.ffmpeg })
      parts.push(data)
      yield data
    }
  }

  /** Кусок гонки: играет основной или параллельный, основной дописывается в кэш в любом случае. */
  async function* race(text: string, req: SpeakRequest, format: Format, k: string, voice: Resolved, spare: { engine: TtsEngine; voice: string } | undefined, signal?: AbortSignal, onFirst: () => void = () => {}): AsyncGenerator<Uint8Array> {
    const need = Date.now()
    const entry = await primaryOf(text, req, format, k, voice)
    const { run, at } = entry
    promote(entry)
    const leave = hold(entry, signal)
    try {
      yield* played()
    } finally {
      leave()
    }

    async function* played(): AsyncGenerator<Uint8Array> {
    const pick: Pick = spare
      ? await pickFirst(
          run,
          (sig) => spare.engine.speak(text, spare.voice, speakOpts(spare.engine, req, format), sig),
          o.parallel?.firstAudioMs ?? 1000,
          signal,
        )
      : { winner: 'primary', first: await untilAbort(run.first, signal), frames: run.frames() }
    if (pick.winner === 'primary') stats.primary++
    else stats.parallel++
    const firstMs = Date.now() - need
    const report = (): void => {
      const primaryMs = run.firstMs()
      o.onPiece?.({
        key: k,
        voice: `${voice.engine}:${voice.voice}`,
        played: pick.winner,
        engine: pick.first.fallback ?? (pick.winner === 'parallel' ? spare?.engine.kind : voice.engine) ?? voice.engine,
        firstMs,
        ...(pick.reason ? { reason: pick.reason } : {}),
        ...(primaryMs !== undefined ? { primaryMs } : {}),
        ...(need - at > 5 ? { aheadMs: need - at } : {}),
        ...(pick.parallelMs !== undefined ? { parallelMs: pick.parallelMs } : {}),
      })
    }
    run.first.then(report, report)
    onFirst()
    const native = pick.winner === 'primary' ? (await engineFor(voice, req)).nativeSpeed : spare?.engine.nativeSpeed
    const it = pick.frames[Symbol.asyncIterator]()
    await it.next()
    try {
      yield* encoded(pick.first, it, native ? 1 : speedOf(req), format, [])
    } finally {
      await it.return?.(undefined)?.catch?.(() => {})
    }
    }
  }

  /** Кусок потоком: кэш/идущий синтез — целиком; иначе кадры движка → (ffmpeg-труба) → наружу и в кэш. */
  async function* live(text: string, req: SpeakRequest, format: Format, signal?: AbortSignal, onFirst: () => void = () => {}): AsyncGenerator<Uint8Array> {
    if (!text.trim()) throw new Error('speak: пустой текст')
    const { key: k, voice } = await key(text, req, format)
    const spare = await raceFor(voice, req)
    if (spare || (await queued(voice, req))) {
      const hit = await o.cache?.get(k)
      if (hit) {
        stats.hits++
        if (req.play === 'now') o.onPiece?.({ key: k, voice: `${voice.engine}:${voice.voice}`, played: 'cache', firstMs: 0 })
        onFirst()
        return yield hit
      }
      if (req.play === 'now') return yield* race(text, req, format, k, voice, spare, signal, onFirst)
      const entry = await primaryOf(text, req, format, k, voice)
      const leave = hold(entry, signal)
      try {
        const r = await untilAbort(entry.run.done, signal)
        onFirst()
        return yield r.data
      } finally {
        leave()
      }
    }
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
    const engine = await engineFor(voice, req)
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
      yield* encoded(first.value, it, tempo, format, parts)
      if (signal?.aborted) throw new Error('speak: синтез отменён')
      const data = concat(parts)
      complete = true
      if (!first.value.fallback) await o.cache?.set(k, data)
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

  async function* stream(raw: readonly string[], req0: SpeakRequest, format: Format, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    if (!raw.length) throw new Error('speak: пустой текст')
    // Кусок из одной разметки (`---`) молчит, а не роняет поток «нет звука».
    const texts = raw.filter((t) => speechText(t))
    const req = await expandCollection(req0, o.collection)
    // wav: один заголовок на поток, куски — сырым PCM.
    const part: Format = format === 'wav' ? 'pcm' : format
    const resolved = await resolve(req.voice, req.engine)
    const racing = !!(await raceFor(resolved, req)) || (await queued(resolved, req))
    let started = false
    let ahead: Promise<SynthResult> | undefined
    for (let i = 0; i < texts.length; i++) {
      // Следующий кусок — заранее, как только у текущего пошёл звук (не в споре за первый байт).
      let next: Promise<SynthResult> | undefined
      const prefetch = (): void => {
        const t = texts[i + 1]
        if (t === undefined || signal?.aborted || next) return
        next = synth(t, racing ? { ...req, play: 'ahead' } : req, part, signal)
        next.catch(() => {})
      }
      // В гонке кусок, заказанный заранее, тоже идёт через `live`: момент «нужен» — сейчас.
      const parts: AsyncIterable<Uint8Array> = ahead && !racing
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
