/**
 * Речь → текст (DEV-252, listen-spec): Gemini 3.5 Transcribe через Gemini API (AI Studio),
 * Interactions API (`POST /v1beta/interactions`). Без Node: HTTP — инъекцией `fetch`; загрузка
 * больших файлов (Files API), длительность и перекодирование — в `/node`.
 *
 * Штатные возможности модели (`generation_config.transcription_config`): `custom_vocabulary`
 * (до 1000 терминов), `language_codes` (пусто — автоопределение), `mode.diarization_mode`,
 * `mode.timestamp_granularities: ['word']`. Провайдер (08.10.2026) отвергает словарь вместе с
 * диаризацией и таймстемпами («custom_vocabulary is incompatible with …»), а диаризация без
 * таймстемпов не отдаёт слов — поэтому сегменты со словарём — два прохода разом (текст со
 * словарём + слова с временем и спикерами без него) и выравнивание слов (`alignWords`).
 *
 * Та же модель на Vertex AI (DEV-258, фолбэк при исчерпанной квоте AI Studio) —
 * `createVertexTranscriber`: `generateContent` с `generationConfig.audioTranscriptionConfig`
 * (`customVocabulary`, `languageCodes`, `wordTimestamp`, `diarization`), OAuth-токен проекта.
 * Словарь с диаризацией Vertex принимает, но (09.10.2026) теряет половину текста — та же схема
 * двух проходов. Файлов Vertex не берёт (нужен gs://) — только inline.
 */

import { retryDelay, vertexRoot, vertexToken } from './gemini.js'
import { abortableSleep, statusError } from './types.js'

export const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe'
/** Потолок словаря у провайдера (лучше всего — до ~100 терминов). */
export const VOCABULARY_LIMIT = 1000

/** Звук запроса: байты inline или файл Files API (`uri` из `/node` `uploadFile`). */
export type AudioInput = { data: Uint8Array; mime: string } | { uri: string; mime: string }

export interface TranscribeOpts {
  /** BCP-47 (`ru`, `en-US`); нет — автоопределение. */
  language?: string | undefined
  /** Термины для распознавания (лексикон ∪ vocabulary ∪ prompt). С сегментами — второй проход, см. шапку. */
  vocabulary?: readonly string[] | undefined
  /** Спикеры у сегментов (включает и таймстемпы). */
  diarize?: boolean | undefined
  /** Сегменты с таймстемпами (verbose_json). */
  segments?: boolean | undefined
  signal?: AbortSignal | undefined
}

export interface TranscriptWord {
  text: string
  start: number
  end: number
  speaker?: string | undefined
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string | undefined
}

export interface Transcript {
  text: string
  /** Язык: заданный в запросе, иначе — по письменности текста (`ru`/`en`); провайдер его не отдаёт. */
  language?: string | undefined
  segments?: TranscriptSegment[] | undefined
  words?: TranscriptWord[] | undefined
  model: string
  /** Сколько терминов словаря ушло в запрос (0 — без словаря); с сегментами и словарём — два запроса. */
  vocabulary: number
}

export interface SttEngine {
  readonly kind: string
  readonly model: string
  transcribe(audio: AudioInput, opts?: TranscribeOpts): Promise<Transcript>
}

export interface GeminiTranscriberOpts {
  apiKey: string
  /** Корень API (`https://generativelanguage.googleapis.com`); путь срезается. */
  baseUrl?: string | undefined
  model?: string | undefined
  fetch?: typeof fetch | undefined
  /** Повторы на поминутный 429 (по умолчанию 3) и потолок ожидания, мс. */
  retries?: number | undefined
  maxRetryWait?: number | undefined
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
}

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com'

const rootOf = (baseUrl: string | undefined): string => {
  if (!baseUrl) return GEMINI_ROOT
  try {
    return new URL(baseUrl).origin
  } catch {
    return GEMINI_ROOT
  }
}

function b64encode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Термины без дублей (без регистра), пустых и сверх потолка — порядок источников сохраняется. */
export function mergeVocabulary(...lists: readonly (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists)
    for (const raw of list ?? []) {
      const w = raw.trim()
      const k = w.toLowerCase()
      if (!w || seen.has(k)) continue
      seen.add(k)
      out.push(w)
    }
  return out.slice(0, VOCABULARY_LIMIT)
}

/** Тело Interactions API. Сегменты — без словаря (провайдер их не совмещает). */
export function transcribeBody(audio: AudioInput, model: string, o: TranscribeOpts = {}): Record<string, unknown> {
  const item = 'uri' in audio ? { type: 'audio', uri: audio.uri, mime_type: audio.mime } : { type: 'audio', data: b64encode(audio.data), mime_type: audio.mime }
  const timed = !!(o.segments || o.diarize)
  const cfg: Record<string, unknown> = {}
  if (o.language) cfg.language_codes = [o.language]
  const vocab = timed ? [] : mergeVocabulary(o.vocabulary)
  if (vocab.length) cfg.custom_vocabulary = vocab
  if (timed) cfg.mode = { type: 'verbatim', timestamp_granularities: ['word'], ...(o.diarize ? { diarization_mode: 'speaker' } : {}) }
  return { model, input: [item], ...(Object.keys(cfg).length ? { generation_config: { transcription_config: cfg } } : {}) }
}

/** `"1.300s"` → 1.3. */
export const seconds = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/s$/, ''))
  return Number.isFinite(n) ? n : 0
}

/** `spk:0` → `A`, `spk:1` → `B` (как diarized-ответы OpenAI); незнакомое — как есть. */
export function speakerLabel(raw: string): string {
  const m = /(\d+)$/.exec(raw)
  if (!m) return raw
  const n = Number(m[1])
  return n < 26 ? String.fromCharCode(65 + n) : `S${n + 1}`
}

/** Язык по письменности: кириллица — `ru`, латиница — `en`; пусто — нет. */
export function guessLanguage(text: string): string | undefined {
  const cyr = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length
  const lat = (text.match(/\p{Script=Latin}/gu) ?? []).length
  if (!cyr && !lat) return undefined
  return cyr >= lat ? 'ru' : 'en'
}

/**
 * Слова → сегменты: новый сегмент на смене спикера, после конца предложения, на паузе
 * больше `gap` с и сверх `maxWords` слов. Текст сегмента — слова через пробел.
 */
export function segmentsOf(words: readonly TranscriptWord[], o: { gap?: number; maxWords?: number } = {}): TranscriptSegment[] {
  const gap = o.gap ?? 1
  const maxWords = o.maxWords ?? 40
  const out: TranscriptSegment[] = []
  let cur: TranscriptWord[] = []
  const flush = (): void => {
    if (!cur.length) return
    const sp = cur[0]!.speaker
    out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.text).join(' '), ...(sp ? { speaker: sp } : {}) })
    cur = []
  }
  for (const w of words) {
    const prev = cur[cur.length - 1]
    if (prev && (w.speaker !== prev.speaker || /[.!?…]["»”)]*$/.test(prev.text) || w.start - prev.end > gap || cur.length >= maxWords)) flush()
    cur.push(w)
  }
  flush()
  return out
}

interface InteractionResponse {
  status?: string
  steps?: { type?: string; content?: { type?: string; text?: string; annotations?: Record<string, unknown>[] }[] }[]
  error?: { message?: string }
}

/** Ответ Interactions → текст и слова (`word_info`). */
export function parseInteraction(raw: unknown): { text: string; words: TranscriptWord[] } {
  const body = (raw ?? {}) as InteractionResponse
  const texts: string[] = []
  const words: TranscriptWord[] = []
  for (const step of body.steps ?? []) {
    if (step.type && step.type !== 'model_output') continue
    for (const c of step.content ?? []) {
      if (c.type && c.type !== 'text') continue
      if (c.text) texts.push(c.text)
      for (const a of c.annotations ?? []) {
        if (a.type !== 'word_info' || typeof a.text !== 'string') continue
        const sp = typeof a.speaker === 'string' ? speakerLabel(a.speaker) : undefined
        words.push({ text: a.text, start: seconds(a.start_offset), end: seconds(a.end_offset), ...(sp ? { speaker: sp } : {}) })
      }
    }
  }
  // С диаризацией реплики приходят слитно («стриминг.Всё верно») — пробел после конца предложения.
  return { text: texts.join('\n').trim().replace(/([\p{Ll}\p{N}][.!?…])(?=\p{Lu}\p{Ll})/gu, '$1 '), words }
}

async function errorOf(res: Response, model: string): Promise<Error> {
  const raw = await res.text().catch(() => '')
  let msg = raw.slice(0, 300)
  try {
    msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? msg
  } catch {
    // не JSON — как есть
  }
  return statusError(`listen: ${model} HTTP ${res.status}${msg ? ` — ${msg}` : ''}`, res.status)
}

export function createGeminiTranscriber(o: GeminiTranscriberOpts): SttEngine {
  const model = o.model || TRANSCRIBE_MODEL
  const url = `${rootOf(o.baseUrl)}/v1beta/interactions`
  const http = o.fetch ?? fetch
  const retries = o.retries ?? 3
  const maxWait = o.maxRetryWait ?? 30_000
  const sleep = o.sleep ?? abortableSleep

  /** Один запрос: повторы поминутного 429, ошибка провайдера — текстом со статусом. */
  async function once(audio: AudioInput, opts: TranscribeOpts): Promise<{ text: string; words: TranscriptWord[] }> {
    const payload = JSON.stringify(transcribeBody(audio, model, opts))
    let res: Response
    for (let attempt = 0; ; attempt++) {
      res = await http(url, { method: 'POST', headers: { 'x-goog-api-key': o.apiKey, 'content-type': 'application/json' }, body: payload, ...(opts.signal ? { signal: opts.signal } : {}) })
      if (res.status !== 429) break
      const text = await res.clone().text().catch(() => '')
      const wait = retryDelay(text)
      if (/PerDay/i.test(text) || attempt >= retries || wait > maxWait) break
      await sleep(wait, opts.signal)
    }
    if (!res.ok) throw await errorOf(res, model)
    const data = (await res.json()) as InteractionResponse
    if (data.error) throw statusError(`listen: ${model} — ${data.error.message ?? 'ошибка провайдера'}`, 502)
    if (data.status && data.status !== 'completed') throw statusError(`listen: ${model} — статус «${data.status}»`, 502)
    return parseInteraction(data)
  }

  return { kind: 'studio', model, transcribe: (audio, opts = {}) => transcribeWith(once, model, audio, opts) }
}

/**
 * Распознавание поверх одного запроса `once`: словарь с сегментами — два прохода разом (текст со
 * словарём, слова с временем и спикерами без него) и выравнивание; язык — заданный или по тексту.
 */
async function transcribeWith(
  once: (audio: AudioInput, opts: TranscribeOpts) => Promise<{ text: string; words: TranscriptWord[] }>,
  model: string,
  audio: AudioInput,
  opts: TranscribeOpts,
): Promise<Transcript> {
  const timed = !!(opts.segments || opts.diarize)
  const vocab = mergeVocabulary(opts.vocabulary)
  let text: string
  let words: TranscriptWord[] = []
  if (timed && vocab.length) {
    const [a, b] = await Promise.all([once(audio, { ...opts, segments: false, diarize: false, vocabulary: vocab }), once(audio, { ...opts, vocabulary: [] })])
    text = a.text
    words = alignWords(a.text, b.words)
  } else {
    ;({ text, words } = await once(audio, { ...opts, vocabulary: vocab }))
  }
  const language = opts.language || guessLanguage(text)
  return {
    text,
    ...(language ? { language } : {}),
    ...(timed ? { words, segments: segmentsOf(words) } : {}),
    model,
    vocabulary: vocab.length,
  }
}

// --- Vertex AI ---

/** Модель на Vertex: GA-имя `gemini-3.5-transcribe` проекту (09.10.2026) отвечает 404, preview — работает. */
export const VERTEX_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-preview'

export interface VertexTranscriberOpts {
  /** Проект GCP (он же `x-goog-user-project`). */
  project: string
  /** Регион; модель есть в `global` (по умолчанию). */
  location?: string | undefined
  /** Подмена корня API (тесты, прокси). */
  baseUrl?: string | undefined
  model?: string | undefined
  /** Свежий OAuth-токен (ADC); кэшируется на `tokenTtl`. */
  token: () => Promise<string>
  tokenTtl?: number | undefined
  now?: (() => number) | undefined
  fetch?: typeof fetch | undefined
  /** Повторы 429 (квота Vertex — токены звука в минуту, «Resource has been exhausted»), по умолчанию 3. */
  retries?: number | undefined
  maxRetryWait?: number | undefined
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
}

/** Тело Vertex `generateContent`. Сегменты — без словаря (как у Studio, см. шапку). */
export function vertexTranscribeBody(audio: AudioInput, o: TranscribeOpts = {}): Record<string, unknown> {
  if ('uri' in audio) throw statusError('listen: Vertex не берёт файлы Files API — только inline', 413)
  const timed = !!(o.segments || o.diarize)
  const cfg: Record<string, unknown> = {}
  if (o.language) cfg.languageCodes = [o.language]
  const vocab = timed ? [] : mergeVocabulary(o.vocabulary)
  if (vocab.length) cfg.customVocabulary = vocab
  if (timed) cfg.wordTimestamp = true
  if (o.diarize) cfg.diarization = true
  return {
    contents: [{ role: 'user', parts: [{ inlineData: { data: b64encode(audio.data), mimeType: audio.mime } }] }],
    ...(Object.keys(cfg).length ? { generationConfig: { audioTranscriptionConfig: cfg } } : {}),
  }
}

interface VertexResponse {
  candidates?: {
    content?: { parts?: { text?: string; audioTranscription?: { text?: string; speakerLabel?: string; words?: { word?: string; startOffset?: unknown; endOffset?: unknown }[] } }[] }
    finishReason?: string
  }[]
}

/** Ответ Vertex → текст и слова: часть — реплика (`speakerLabel` у диаризации), слова — `words`. */
export function parseVertex(raw: unknown): { text: string; words: TranscriptWord[] } {
  const texts: string[] = []
  const words: TranscriptWord[] = []
  for (const c of ((raw ?? {}) as VertexResponse).candidates?.slice(0, 1) ?? [])
    for (const p of c.content?.parts ?? []) {
      const a = p.audioTranscription
      const t = a?.text ?? p.text
      if (t) texts.push(t)
      const sp = a?.speakerLabel ? speakerLabel(a.speakerLabel) : undefined
      for (const w of a?.words ?? []) if (typeof w.word === 'string') words.push({ text: w.word, start: seconds(w.startOffset), end: seconds(w.endOffset), ...(sp ? { speaker: sp } : {}) })
    }
  return { text: texts.join('\n').trim(), words }
}

export function createVertexTranscriber(o: VertexTranscriberOpts): SttEngine {
  const model = o.model || VERTEX_TRANSCRIBE_MODEL
  const location = o.location || 'global'
  const url = `${o.baseUrl ? rootOf(o.baseUrl) : vertexRoot(location)}/v1beta1/projects/${encodeURIComponent(o.project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${model}:generateContent`
  const http = o.fetch ?? fetch
  const retries = o.retries ?? 3
  const maxWait = o.maxRetryWait ?? 30_000
  const sleep = o.sleep ?? abortableSleep
  const token = vertexToken(o.token, o.tokenTtl, o.now)

  async function once(audio: AudioInput, opts: TranscribeOpts): Promise<{ text: string; words: TranscriptWord[] }> {
    const payload = JSON.stringify(vertexTranscribeBody(audio, opts))
    let res: Response
    let fresh = false
    let reauthed = false
    for (let attempt = 0; ; ) {
      const headers = { authorization: `Bearer ${await token(fresh)}`, 'x-goog-user-project': o.project, 'content-type': 'application/json' }
      fresh = false
      res = await http(url, { method: 'POST', headers, body: payload, ...(opts.signal ? { signal: opts.signal } : {}) })
      if (res.status === 401 && !reauthed) {
        // Токен протух раньше срока кэша — одно обновление и повтор.
        await res.body?.cancel().catch(() => {})
        fresh = reauthed = true
        continue
      }
      if (res.status !== 429) break
      // Срока Vertex не называет; лимит — токены звука в минуту: паузы нарастают 2, 6, 18 с.
      const wait = Math.min(maxWait, 2000 * 3 ** attempt)
      if (attempt >= retries) break
      attempt++
      await sleep(wait, opts.signal)
    }
    if (!res.ok) throw await errorOf(res, `vertex:${model}`)
    const data = (await res.json()) as VertexResponse
    const reason = data.candidates?.[0]?.finishReason
    if (reason && reason !== 'STOP') throw statusError(`listen: vertex:${model} — finishReason «${reason}»`, 502)
    return parseVertex(data)
  }

  return { kind: 'vertex', model, transcribe: (audio, opts = {}) => transcribeWith(once, model, audio, opts) }
}

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Слова текста `text` получают время и спикера от слов другого прохода (`timed`):
 * выравнивание Нидлмана — Вунша по нормализованным словам (совпадение +2, замена −0.5,
 * пропуск −1: «Сулафат» ↔ «Sulafat» встают в пару как замена). Слово без пары — время между
 * соседями, спикер — предыдущего.
 */
export function alignWords(text: string, timed: readonly TranscriptWord[]): TranscriptWord[] {
  const a = text.split(/\s+/).filter(Boolean)
  const n = a.length
  const m = timed.length
  if (!n) return []
  if (!m) return a.map((t) => ({ text: t, start: 0, end: 0 }))
  const an = a.map(norm)
  const bn = timed.map((w) => norm(w.text))
  const MATCH = 2
  const SUB = -0.5
  const GAP = -1
  // Траектория: 0 — диагональ, 1 — пропуск в b (слово a без пары), 2 — пропуск в a.
  const dir = new Uint8Array((n + 1) * (m + 1))
  let prev = new Float64Array(m + 1)
  let cur = new Float64Array(m + 1)
  for (let j = 0; j <= m; j++) {
    prev[j] = j * GAP
    dir[j] = 2
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i * GAP
    dir[i * (m + 1)] = 1
    for (let j = 1; j <= m; j++) {
      const d = prev[j - 1]! + (an[i - 1] && an[i - 1] === bn[j - 1] ? MATCH : SUB)
      const up = prev[j]! + GAP
      const left = cur[j - 1]! + GAP
      if (d >= up && d >= left) [cur[j], dir[i * (m + 1) + j]] = [d, 0]
      else if (up >= left) [cur[j], dir[i * (m + 1) + j]] = [up, 1]
      else [cur[j], dir[i * (m + 1) + j]] = [left, 2]
    }
    ;[prev, cur] = [cur, prev]
  }
  const pair: (number | undefined)[] = new Array(n)
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const d = dir[i * (m + 1) + j]
    if (i > 0 && j > 0 && d === 0) pair[--i] = --j
    else if (i > 0 && (j === 0 || d === 1)) i--
    else j--
  }
  const out: TranscriptWord[] = a.map((t, i) => {
    const w = pair[i] !== undefined ? timed[pair[i]!] : undefined
    return w ? { text: t, start: w.start, end: w.end, ...(w.speaker ? { speaker: w.speaker } : {}) } : { text: t, start: NaN, end: NaN }
  })
  // Без пары: время — между соседями с парой, спикер — предыдущего (или следующего).
  for (let i = 0; i < n; i++) {
    const w = out[i]!
    if (!Number.isNaN(w.start)) continue
    let l = i - 1
    while (l >= 0 && Number.isNaN(out[l]!.start)) l--
    let r = i + 1
    while (r < n && Number.isNaN(out[r]!.start)) r++
    const left = l >= 0 ? out[l]! : undefined
    const right = r < n ? out[r]! : undefined
    w.start = left ? left.end : (right?.start ?? 0)
    w.end = right ? right.start : (left?.end ?? w.start)
    if (w.end < w.start) w.end = w.start
    const sp = left?.speaker ?? right?.speaker
    if (sp) w.speaker = sp
  }
  return out
}

/** Mime по сигнатуре байтов: что модель берёт как есть; нет — перекодировать (ffmpeg). */
export function sniffAudio(b: Uint8Array): string | undefined {
  const at = (i: number, s: string): boolean => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0))
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav'
  if (at(0, 'ID3')) return 'audio/mp3'
  if (at(0, 'OggS')) return 'audio/ogg'
  if (at(0, 'fLaC')) return 'audio/flac'
  if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC'))) return 'audio/aiff'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm'
  if (at(4, 'ftyp')) return /^(M4A |M4B |mp42|isom|dash|iso[2-6])/.test(String.fromCharCode(...b.subarray(8, 12))) ? 'audio/m4a' : undefined
  if (b[0] === 0xff && b[1] !== undefined) {
    if ((b[1] & 0xf6) === 0xf0) return 'audio/aac' // ADTS
    if ((b[1] & 0xe0) === 0xe0) return 'audio/mp3' // кадр MPEG без ID3
  }
  return undefined
}

// --- OpenAI-совместимый /v1/audio/transcriptions (llm-gate, gate-media-spec §7) ---

export interface OpenAITranscriberOpts {
  /** Корень API с `/v1` или без (`https://llm.notreal.studio`). */
  baseUrl: string
  apiKey?: string | undefined
  /** Модель (алиас гейта `$output: transcribe`). */
  model: string
  fetch?: typeof fetch | undefined
}

const AUDIO_EXT: Record<string, string> = { 'audio/wav': 'wav', 'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/webm': 'webm', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/aiff': 'aiff' }

interface VerboseJson {
  text?: string
  language?: string
  words?: Array<{ word?: string; text?: string; start?: number; end?: number; speaker?: string }>
  segments?: Array<{ start?: number; end?: number; text?: string; speaker?: string }>
}

/** Языки verbose_json OpenAI — словами (`russian`); назад в код — для известных. */
const LANG_CODES: Record<string, string> = { russian: 'ru', english: 'en', ukrainian: 'uk', german: 'de', french: 'fr', spanish: 'es' }

/**
 * Распознавание через OpenAI-совместимый сервер (гейт, speak): multipart `file`, `model`,
 * `language`, `prompt` (словарь — через запятую), `response_format: verbose_json` +
 * `timestamp_granularities[]=word`, `diarize` (расширение speak/гейта). Слова — `TranscriptWord[]`.
 * Повторов 429 нет — их делает сервер (у гейта — фолбэк алиаса).
 */
export function createOpenAITranscriber(o: OpenAITranscriberOpts): SttEngine {
  const url = `${o.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/audio/transcriptions`
  const http = o.fetch ?? fetch
  return {
    kind: 'openai',
    model: o.model,
    async transcribe(audio, opts = {}) {
      if ('uri' in audio) throw statusError('listen: OpenAI-совместимый сервер не берёт файлы Files API — только байты', 413)
      const timed = !!(opts.segments || opts.diarize)
      const vocab = mergeVocabulary(opts.vocabulary)
      const form = new FormData()
      form.append('file', new Blob([audio.data as BlobPart], { type: audio.mime }), `audio.${AUDIO_EXT[audio.mime] ?? 'bin'}`)
      form.append('model', o.model)
      form.append('response_format', 'verbose_json')
      if (timed) form.append('timestamp_granularities[]', 'word')
      if (opts.language) form.append('language', opts.language)
      if (vocab.length) form.append('prompt', vocab.join(', '))
      if (opts.diarize) form.append('diarize', 'true')
      const res = await http(url, { method: 'POST', headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}, body: form, ...(opts.signal ? { signal: opts.signal } : {}) })
      if (!res.ok) throw await errorOf(res, o.model)
      const data = (await res.json()) as VerboseJson
      const text = (data.text ?? '').trim()
      const words: TranscriptWord[] = (data.words ?? []).map((w) => ({ text: String(w.word ?? w.text ?? ''), start: Number(w.start ?? 0), end: Number(w.end ?? 0), ...(w.speaker ? { speaker: w.speaker } : {}) }))
      const segments: TranscriptSegment[] | undefined = data.segments?.length
        ? data.segments.map((s) => ({ start: Number(s.start ?? 0), end: Number(s.end ?? 0), text: String(s.text ?? '').trim(), ...(s.speaker ? { speaker: s.speaker } : {}) }))
        : undefined
      const lang = data.language ? (LANG_CODES[data.language.toLowerCase()] ?? data.language) : undefined
      const language = opts.language || lang || guessLanguage(text)
      return {
        text,
        ...(language ? { language } : {}),
        ...(timed ? { words, segments: segments ?? segmentsOf(words) } : {}),
        model: o.model,
        vocabulary: vocab.length,
      }
    },
  }
}
