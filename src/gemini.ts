/**
 * Движки Gemini 3.8 TTS (перенос `nrchat/plugins/voice/engine.ts`, DEV-247 — поведение
 * без изменений). Один провод — `streamGenerateContent?alt=sse`: кадры сырого PCM по
 * ~40 мс, первый звук раньше, чем модель договорила фразу.
 *
 * - `createGeminiEngine` — AI Studio по ключу; свои голоса (`voice_…`, Voice design).
 * - `createVertexEngine` — Vertex AI по OAuth-токену: без суточного лимита AI Studio,
 *   только Flash и только студийные голоса (`Kore`, `Puck`, …).
 * - `createRoutedEngine` — маршрут по голосу: `voice_…` → AI Studio, студийные → Vertex.
 *
 * Общее (тело запроса, SSE, кадры PCM, ретраи 429) — `speakStream`. Без Node: HTTP —
 * инъекцией `fetch`, кэш дизайнов — инъекцией `VoiceCache`.
 */

import type { AudioChunk, DesignSpec, LibraryCache, ReplicateSpec, SpeakOpts, TtsEngine, VoiceCache, VoiceInfo } from './types.js'
import { concat, parseWav, wavHeader } from './audio.js'

/** Повторы синтеза на 429 — у обоих движков одинаково. */
export interface RetryOpts {
  /** Повторы синтеза на 429 (по умолчанию 3) и потолок ожидания одного повтора, мс. */
  retries?: number | undefined
  maxRetryWait?: number | undefined
  /** Ожидание перед повтором (тесты подменяют). */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
}

export interface GeminiOpts extends RetryOpts {
  apiKey: string
  /** Корень API: `https://generativelanguage.googleapis.com` (путь `/v1beta/openai` срезается). */
  baseUrl?: string | undefined
  /** Модель реплик. */
  model?: string | undefined
  /** Голос для `voice: ''` — встроенный (`Charon`) или `voice_…`. */
  defaultVoice?: string | undefined
  cache: VoiceCache
  fetch?: typeof fetch | undefined
  /** Лимит голосов проекта у провайдера (200 у Gemini). */
  limit?: number | undefined
  /** Кэш библиотеки готовых голосов (2000+ записей, сутки); нет — каждый раз из API. */
  libraryCache?: LibraryCache | undefined
  /** Модель, к которой привязывается клон (`replicated`). */
  replicateModel?: string | undefined
}

export interface VertexOpts extends RetryOpts {
  /** Проект GCP с включённым Vertex AI (он же `x-goog-user-project`). */
  project: string
  /** Регион; `global` (по умолчанию) — `aiplatform.googleapis.com`, иначе `<регион>-aiplatform…`. */
  location?: string | undefined
  /** Подмена корня API (тесты, прокси). */
  baseUrl?: string | undefined
  /** Модель реплик; на Vertex есть только Flash TTS. */
  model?: string | undefined
  /** Студийный голос для `voice: ''`. */
  defaultVoice?: string | undefined
  /** Свежий OAuth-токен (у сервиса — `gcloud auth application-default print-access-token`). */
  token: () => Promise<string>
  /** Сколько держать токен, мс (по умолчанию 50 мин; живёт он час). */
  tokenTtl?: number | undefined
  now?: (() => number) | undefined
  fetch?: typeof fetch | undefined
}

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com'
export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts'
export const GEMINI_DEFAULT_VOICE = 'Charon'
export const GEMINI_VOICE_LIMIT = 200
export const VERTEX_TTS_MODEL = 'gemini-3.8-flash-tts'
export const VERTEX_DEFAULT_VOICE = 'Kore'
export const VERTEX_LOCATION = 'global'

/** 30 студийных голосов Gemini TTS — те же, что `prebuilt` у AI Studio; на Vertex других нет. */
export const STUDIO_VOICES: readonly { id: string; gender: 'female' | 'male' }[] = (
  [
    ['Zephyr', 'female'], ['Puck', 'male'], ['Charon', 'male'], ['Kore', 'female'], ['Fenrir', 'male'],
    ['Leda', 'female'], ['Orus', 'male'], ['Aoede', 'female'], ['Callirrhoe', 'female'], ['Autonoe', 'female'],
    ['Enceladus', 'male'], ['Iapetus', 'male'], ['Umbriel', 'male'], ['Algieba', 'male'], ['Despina', 'female'],
    ['Erinome', 'female'], ['Algenib', 'male'], ['Rasalgethi', 'male'], ['Laomedeia', 'female'], ['Achernar', 'female'],
    ['Alnilam', 'male'], ['Schedar', 'male'], ['Gacrux', 'female'], ['Pulcherrima', 'female'], ['Achird', 'male'],
    ['Zubenelgenubi', 'male'], ['Vindemiatrix', 'female'], ['Sadachbia', 'male'], ['Sadaltager', 'male'], ['Sulafat', 'female'],
  ] as const
).map(([id, gender]) => ({ id, gender }))

/** Свой голос (Voice design) — Vertex его не видит. */
export const VERTEX_NO_CUSTOM = 'Vertex не поддерживает свои голоса (voice_…) — используй студийный (Kore, Puck, Charon, …) или движок gemini'

/** Ключ кэша дизайнов — как у форка: `lang|design` (дизайн до вырезки акцента). */
export const cacheKey = (lang: string, design: string): string => `${lang}|${design}`

/** Корень API из `$base_url` провайдера (у `google` в конфиге — OpenAI-совместимый путь). */
export function geminiRoot(baseUrl: string | undefined): string {
  if (!baseUrl) return GEMINI_BASE
  try {
    return new URL(baseUrl).origin
  } catch {
    return GEMINI_BASE
  }
}

/**
 * Дизайн под язык провайдера: якорь акцента композитора — для английского
 * Maya1; на чужом языке он просил бы только иностранный акцент (форк).
 */
export function designFor(design: string, lang: string): string {
  return lang.toLowerCase().startsWith('en') ? design : design.replace(/,\s*(American|British) accent/g, '')
}

/** Студийный голос (`Kore`, `charon`) — каноническое имя; иначе undefined. */
export function studioVoice(id: string): string | undefined {
  const n = id.toLowerCase()
  return STUDIO_VOICES.find((v) => v.id.toLowerCase() === n)?.id
}

/**
 * `voiceConfig`: студийный — по имени (`prebuiltVoiceConfig`), всё остальное — свой `voice_…`
 * и голос библиотеки (`en-us-neno`) — по id (`voice`).
 */
export function voiceConfig(id: string): Record<string, unknown> {
  const studio = studioVoice(id)
  return studio ? { prebuiltVoiceConfig: { voiceName: studio } } : { voice: id }
}

/** Библиотечный голос AI Studio (не студийный и не свой) — Vertex его не знает. */
export const VERTEX_NO_LIBRARY = (id: string): string => `голос «${id}» — из библиотеки AI Studio, Vertex его не знает: studio:${id}`

type ApiVoice = {
  id?: string
  type?: string
  display_name?: string
  gender?: string
  language_code?: string
  prompted?: { input?: string }
  expire_time?: string
  pitch?: string
  accent?: string
  persona?: string
  context?: string
  description?: string
}

/** Запись API голосов → `VoiceInfo` (пустые поля не переносятся). */
export function voiceInfoOf(v: ApiVoice & { id: string }): VoiceInfo {
  return {
    id: v.id,
    ...(v.type ? { type: v.type } : {}),
    ...(v.display_name ? { name: v.display_name } : {}),
    ...(v.gender ? { gender: v.gender } : {}),
    ...(v.language_code ? { lang: v.language_code } : {}),
    ...(v.prompted?.input ? { design: v.prompted.input } : {}),
    ...(v.expire_time ? { expires: v.expire_time } : {}),
    ...(v.pitch ? { pitch: v.pitch } : {}),
    ...(v.accent ? { accent: v.accent } : {}),
    ...(v.persona ? { persona: v.persona } : {}),
    ...(v.context ? { context: v.context } : {}),
    ...(v.description ? { description: v.description } : {}),
  }
}

/** WAV с честным заголовком из любого WAV (стримовый размер, LIST-чанки) или сырого PCM s16 24 кГц. */
export function cleanWav(d: Uint8Array): Uint8Array {
  const { pcm, rate } = parseWav(d)
  return concat([wavHeader(rate, pcm.length), pcm])
}

/** Ошибки клона — человеческим текстом (провайдер отвечает «invalid argument» на всё). */
export function replicateError(status: number, message: string): string {
  if (/consent/i.test(message)) return `согласие не распознано — фраза согласия должна звучать чётко и тем же голосом, что образец (${message})`
  if (/disabled|not enabled|permission/i.test(message)) return `клонирование выключено у проекта (${message})`
  if (status === 400) return `провайдер отклонил запись (${message || 'invalid argument'}): нужен WAV 24 кГц моно s16 с честным заголовком, образец 10–30 с, согласие — фраза целиком`
  return message || `HTTP ${status}`
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Сколько ждать перед повтором: `retry in 6.69s` / `retryDelay: "6s"` в теле 429, иначе 5 с. */
export function retryDelay(body: string): number {
  const m = /retry in ([\d.]+)\s*s/i.exec(body) ?? /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body)
  const sec = m ? Number(m[1]) : 5
  return Math.ceil((Number.isFinite(sec) ? sec : 5) * 1000) + 250
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/** 429 провайдера — текстом: какая квота кончилась и что говорит провайдер. */
function quotaError(body: string, model: string, kind: 'day' | 'minute'): Error {
  let message = body
  try {
    message = ((JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body).split('\n')[0]!
  } catch {
    // не JSON — как есть
  }
  const what = kind === 'day' ? `дневная квота ${model} исчерпана` : `лимит запросов ${model} в минуту`
  const err = new Error(`voice.speak: HTTP 429 — ${what}: ${message}`.slice(0, 400))
  ;(err as Error & { status?: number }).status = 429
  return err
}

async function failure(res: Response, what: string): Promise<Error> {
  let text = ''
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } }
    text = body.error?.message ?? ''
  } catch {
    // тело не JSON — хватит статуса
  }
  const err = new Error(`${what}: HTTP ${res.status}${text ? ` — ${text}` : ''}`)
  ;(err as Error & { status?: number }).status = res.status
  return err
}

/** Разбор SSE `data:` строк по мере прихода байтов. */
async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.startsWith('data:')) {
          const json = line.slice(5).trim()
          if (json && json !== '[DONE]') yield JSON.parse(json)
        }
      }
    }
    const tail = buf.trim()
    if (tail.startsWith('data:')) yield JSON.parse(tail.slice(5).trim())
  } finally {
    reader.releaseLock()
    if (signal?.aborted) await body.cancel().catch(() => {})
  }
}

interface GeminiChunk {
  candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[]
  error?: { message?: string }
}

/** Тело синтеза: одно на оба движка; тон реплики — `speech_metadata.style`. */
export function speakBody(text: string, voiceId: string, opts: SpeakOpts): Record<string, unknown> {
  const part: Record<string, unknown> = { text }
  if (opts.instruct?.trim()) part.speech_metadata = { style: opts.instruct.trim() }
  return {
    contents: [{ role: 'user', parts: [part] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: voiceConfig(voiceId) } },
  }
}

interface SpeakReq {
  http: typeof fetch
  url: string
  /** Заголовки на каждую попытку: `fresh` — после 401 (Vertex обновляет токен). */
  headers: (fresh: boolean) => Promise<Record<string, string>>
  /** Есть — на 401 одно обновление авторизации и повтор. */
  reauth?: boolean
  model: string
  body: Record<string, unknown>
  retry: RetryOpts
  signal?: AbortSignal
}

/** Синтез стримом: запрос, повторы 429 (и 401 — раз), SSE → кадры PCM. */
async function* speakStream(r: SpeakReq): AsyncGenerator<AudioChunk> {
  const retries = r.retry.retries ?? 3
  const maxWait = r.retry.maxRetryWait ?? 30_000
  const sleep = r.retry.sleep ?? abortableSleep
  const { signal } = r
  let res: Response
  let fresh = false
  // 429 — лимит запросов: поминутный переждать (сколько сказал провайдер)
  // и повторить — реплика опоздает, но прозвучит; дневной — ошибка сразу.
  for (let attempt = 0; ; ) {
    res = await r.http(r.url, {
      method: 'POST',
      headers: await r.headers(fresh),
      body: JSON.stringify(r.body),
      ...(signal ? { signal } : {}),
    })
    if (res.status === 401 && r.reauth && !fresh) {
      // Токен протух раньше срока кэша — одно обновление и повтор.
      await res.body?.cancel().catch(() => {})
      fresh = true
      continue
    }
    if (res.status !== 429) break
    const text = await res.text().catch(() => '')
    const wait = retryDelay(text)
    if (/PerDay/i.test(text)) throw quotaError(text, r.model, 'day')
    if (attempt >= retries || wait > maxWait) throw quotaError(text, r.model, 'minute')
    attempt++
    await sleep(wait, signal)
    if (signal?.aborted) return
  }
  if (!res.ok || !res.body) throw await failure(res, 'voice.speak')
  for await (const raw of sseData(res.body, signal)) {
    const chunk = raw as GeminiChunk
    if (chunk.error) throw new Error(`voice.speak: ${chunk.error.message ?? 'ошибка провайдера'}`)
    for (const c of chunk.candidates ?? []) {
      for (const p of c.content?.parts ?? []) {
        const blob = p.inlineData
        if (blob?.data) yield { data: b64decode(blob.data), mime: blob.mimeType ?? 'audio/wav' }
      }
    }
  }
}

export function createGeminiEngine(o: GeminiOpts): TtsEngine {
  const root = geminiRoot(o.baseUrl)
  const model = o.model || GEMINI_TTS_MODEL
  const http = o.fetch ?? fetch
  const limit = o.limit ?? GEMINI_VOICE_LIMIT
  const headers = { 'x-goog-api-key': o.apiKey, 'content-type': 'application/json' }

  async function list(filter: string, keep: (v: ApiVoice) => boolean): Promise<VoiceInfo[]> {
    const out: VoiceInfo[] = []
    let token = ''
    // Каталог встроенных голосов — тысячи записей: страницы по 1000.
    for (let page = 0; page < 50; page++) {
      const res = await http(`${root}/v1beta/voices?pageSize=1000${filter}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { headers })
      if (!res.ok) throw await failure(res, 'voice.voices')
      const body = (await res.json()) as { voices?: ApiVoice[]; next_page_token?: string; nextPageToken?: string }
      for (const v of body.voices ?? []) if (v.id && keep(v)) out.push(voiceInfoOf(v as ApiVoice & { id: string }))
      token = body.next_page_token ?? body.nextPageToken ?? ''
      if (!token) break
    }
    return out
  }

  const voices = (opts: { prebuilt?: boolean } = {}): Promise<VoiceInfo[]> => list('', (v) => v.type !== 'prebuilt' || !!opts.prebuilt)

  async function library(lo: { fresh?: boolean } = {}): Promise<VoiceInfo[]> {
    if (!lo.fresh) {
      const hit = await o.libraryCache?.get()
      if (hit?.length) return hit
    }
    const got = await list('&type=prebuilt', (v) => v.type === 'prebuilt')
    if (got.length) await o.libraryCache?.set(got)
    return got
  }

  return {
    kind: 'gemini',
    limit,
    voices,
    library,

    async replicate(spec: ReplicateSpec) {
      if (!spec.source.length || !spec.consent.length) throw new Error('voice.replicate: нужны образец и согласие')
      // Честный заголовок WAV: ffmpeg в трубу пишет размер 0xFFFFFFFF — на нём REST отвечает 400.
      const b64 = (d: Uint8Array): string => b64encode(cleanWav(d))
      const body = {
        store: true,
        voice: {
          type: 'replicated',
          model: o.replicateModel ?? VERTEX_TTS_MODEL,
          display_name: spec.name.trim().slice(0, 60) || 'clone',
          ...(spec.lang ? { language_code: spec.lang } : {}),
          replicated: { source_audio: { mime_type: 'audio/wav', data: b64(spec.source) }, consent_audio: { mime_type: 'audio/wav', data: b64(spec.consent) } },
        },
      }
      const res = await http(`${root}/v1beta/voices`, { method: 'POST', headers, body: JSON.stringify(body) })
      if (!res.ok) {
        const err = await failure(res, 'voice.replicate')
        const msg = err.message.replace(/^voice\.replicate: HTTP \d+( — )?/, '')
        const out = new Error(`voice.replicate: ${replicateError(res.status, msg)}`)
        ;(out as Error & { status?: number }).status = res.status
        throw out
      }
      const id = String(((await res.json()) as { id?: unknown }).id ?? '')
      if (!id) throw new Error('voice.replicate: провайдер не вернул id голоса')
      return { id }
    },

    async remove(id: string) {
      if (!id.startsWith('voice_')) throw new Error(`voice.remove: «${id}» — не свой голос`)
      const res = await http(`${root}/v1beta/voices/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
      if (!res.ok && res.status !== 404) throw await failure(res, 'voice.remove')
    },

    async design(spec) {
      const design = spec.design.trim()
      if (!design) throw new Error('voice.design: пустой дизайн')
      const lang = spec.lang?.trim() || 'en-US'
      const key = cacheKey(lang, design)
      const hit = spec.fresh ? undefined : o.cache.get(key)
      if (hit) return { id: hit, cached: true }
      const gender = spec.gender === 'female' || spec.gender === 'male' ? spec.gender : design.toLowerCase().startsWith('female') ? 'female' : 'male'
      // Без voice.model: голос проектирует модель по умолчанию (Flash TTS), а id
      // потом годится любой TTS-модели, в том числе flash-lite для реплик (форк).
      const body = {
        store: true,
        voice: {
          type: 'prompted',
          display_name: `nrchat ${spec.name ?? ''}`.trim().slice(0, 60),
          gender,
          language_code: lang,
          prompted: { input: designFor(design, lang) },
        },
      }
      const res = await http(`${root}/v1beta/voices`, { method: 'POST', headers, body: JSON.stringify(body) })
      if (!res.ok) {
        const err = await failure(res, 'voice.design')
        // Переполнение проекта — не молча: считаем голоса и говорим прямо.
        const count = await voices().then((v) => v.length).catch(() => -1)
        if (count >= limit) throw new Error(`voice.design: у проекта ${count} голосов из ${limit} — лимит исчерпан, новых голосов не будет (удалите лишние у провайдера). ${err.message}`)
        throw err
      }
      const id = String(((await res.json()) as { id?: unknown }).id ?? '')
      if (!id) throw new Error('voice.design: провайдер не вернул id голоса')
      if (!spec.fresh) o.cache.set(key, id)
      return { id, cached: false }
    },

    speak: (text, voiceId, opts, signal) =>
      speakStream({
        http,
        url: `${root}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        headers: async () => headers,
        model,
        body: speakBody(text, voiceId || o.defaultVoice || GEMINI_DEFAULT_VOICE, opts),
        retry: o,
        ...(signal ? { signal } : {}),
      }),
  }
}

/**
 * Токен Vertex с кэшем: на ~50 мин из часа жизни; один запрос за ним на всех ждущих;
 * `fresh` — мимо кэша (после 401). Общий у озвучки и распознавания.
 */
export function vertexToken(get: () => Promise<string>, ttl = 50 * 60_000, now: () => number = Date.now): (fresh?: boolean) => Promise<string> {
  let cached: { token: Promise<string>; at: number } | null = null
  return (fresh = false) => {
    if (fresh || !cached || now() - cached.at >= ttl) {
      const p = get().then((t) => {
        if (!t.trim()) throw new Error('voice: пустой токен Vertex')
        return t.trim()
      })
      cached = { token: p, at: now() }
      p.catch(() => {
        if (cached?.token === p) cached = null
      })
    }
    return cached.token
  }
}

/** Корень Vertex AI: `global` — без региона в хосте. */
export function vertexRoot(location: string): string {
  return location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`
}

/**
 * Vertex AI: тот же синтез, что у Gemini, по OAuth-токену проекта GCP.
 * Свои голоса (Voice design) Vertex не видит — `design` и `voice_…` в `speak`
 * падают понятной ошибкой до запроса; `voices` — 30 студийных.
 */
export function createVertexEngine(o: VertexOpts): TtsEngine {
  const location = o.location || VERTEX_LOCATION
  const model = o.model || VERTEX_TTS_MODEL
  const http = o.fetch ?? fetch
  const ttl = o.tokenTtl ?? 50 * 60_000
  const now = o.now ?? Date.now
  const url = `${o.baseUrl ? geminiRoot(o.baseUrl) : vertexRoot(location)}/v1/projects/${encodeURIComponent(o.project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${model}:streamGenerateContent?alt=sse`
  const token = vertexToken(o.token, ttl, now)

  return {
    kind: 'vertex',
    limit: 0,
    async voices() {
      return STUDIO_VOICES.map((v) => ({ id: v.id, type: 'prebuilt', name: v.id, gender: v.gender }))
    },
    async design() {
      throw new Error(`voice.design: ${VERTEX_NO_CUSTOM}`)
    },
    async *speak(text, voiceId, opts, signal) {
      const voice = voiceId || o.defaultVoice || VERTEX_DEFAULT_VOICE
      if (voice.startsWith('voice_')) throw new Error(`voice.speak: ${VERTEX_NO_CUSTOM}`)
      if (!studioVoice(voice)) throw new Error(`voice.speak: ${VERTEX_NO_LIBRARY(voice)}`)
      yield* speakStream({
        http,
        url,
        headers: async (fresh) => ({ authorization: `Bearer ${await token(fresh)}`, 'x-goog-user-project': o.project, 'content-type': 'application/json' }),
        reauth: true,
        model,
        body: speakBody(text, voice, opts),
        retry: o,
        ...(signal ? { signal } : {}),
      })
    },
  }
}

/**
 * Склейка мелких кадров: у Gemini кадр — 40 мс, по проводу это сотни событий
 * на реплику. Первый кадр уходит сразу (звук как можно раньше), дальше — не
 * меньше `min` байт; смена mime — граница.
 */
export async function* coalesce(chunks: AsyncIterable<AudioChunk>, min = 9600): AsyncGenerator<AudioChunk> {
  let pending: Uint8Array[] = []
  let size = 0
  let mime = ''
  let first = true
  const flush = (): AudioChunk => {
    const data = new Uint8Array(size)
    let at = 0
    for (const p of pending) {
      data.set(p, at)
      at += p.length
    }
    pending = []
    size = 0
    return { data, mime }
  }
  for await (const c of chunks) {
    if (size && c.mime !== mime) yield flush()
    mime = c.mime
    pending.push(c.data)
    size += c.data.length
    if (first || size >= min) {
      first = false
      yield flush()
    }
  }
  if (size) yield flush()
}

export function b64encode(data: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * Маршрут по голосу: свой `voice_…` (Voice design) — в AI Studio, студийный — в Vertex.
 * Дизайн голосов — всегда AI Studio (Vertex своих не умеет). Список — свои из AI Studio
 * плюс каталог Vertex. Так Tavern/nr-play сохраняют голоса персонажей при Vertex по умолчанию.
 */
export function createRoutedEngine(studio: TtsEngine, vertex: TtsEngine): TtsEngine {
  // Студийный (и пустой — голос по умолчанию Vertex) — Vertex; свой и библиотечный — AI Studio.
  const pick = (voice: string): TtsEngine => (!voice || studioVoice(voice) ? vertex : studio)
  return {
    kind: 'routed',
    ...(studio.limit !== undefined ? { limit: studio.limit } : {}),
    async voices(opts) {
      const own = (await studio.voices({})).filter((v) => v.type !== 'prebuilt')
      return opts?.prebuilt ? [...own, ...(await vertex.voices({ prebuilt: true }))] : own
    },
    design: (spec) => studio.design(spec),
    ...(studio.replicate ? { replicate: (spec: ReplicateSpec) => studio.replicate!(spec) } : {}),
    ...(studio.remove ? { remove: (id: string) => studio.remove!(id) } : {}),
    ...(studio.library ? { library: (lo?: { fresh?: boolean }) => studio.library!(lo) } : {}),
    speak: (text, voice, opts, signal) => pick(voice).speak(text, voice, opts, signal),
  }
}
