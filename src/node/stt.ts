/**
 * Речь → текст, Node-половина (DEV-252): звук любого формата → поддерживаемый (ffmpeg),
 * маленький — inline, большой (митинги) — Files API Gemini; длительность — ffprobe;
 * транскрибер по конфигу runz (`## $speak` → `$listen_model`): `studio:` — ключ провайдера AI
 * Studio, `vertex:` (DEV-258) — проект и токен провайдера Vertex, звук только inline.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import type { FfmpegRun } from '../audio.js'
import type { SttEngine, Transcript, TranscribeOpts } from '../stt.js'
import { TRANSCRIBE_MODEL, VERTEX_TRANSCRIBE_MODEL, createGeminiTranscriber, createVertexTranscriber, sniffAudio } from '../stt.js'
import { statusError } from '../types.js'
import { gcloudToken, isVertex, providerOf, speakOpt } from './config.js'

/** Inline — до 14 МБ звука (base64 раздувает на треть, потолок запроса ~20 МБ); больше — Files API. */
export const INLINE_MAX = 14 * 1024 * 1024

export interface FilesApiOpts {
  apiKey: string
  baseUrl?: string | undefined
  fetch?: typeof fetch | undefined
  /** Сколько ждать обработки файла (ACTIVE), мс; по умолчанию 5 мин. */
  timeout?: number | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
}

export interface UploadedFile {
  name: string
  uri: string
  mime: string
}

const rootOf = (baseUrl: string | undefined): string => {
  try {
    return baseUrl ? new URL(baseUrl).origin : 'https://generativelanguage.googleapis.com'
  } catch {
    return 'https://generativelanguage.googleapis.com'
  }
}

async function fail(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => '')
  const err = new Error(`listen: ${what}: HTTP ${res.status} ${text.slice(0, 300)}`.trim())
  ;(err as Error & { status?: number }).status = res.status
  return err
}

/** Файл в Files API (resumable upload одним куском) и ожидание `ACTIVE`. */
export async function uploadFile(o: FilesApiOpts, data: Uint8Array, mime: string, displayName = 'audio'): Promise<UploadedFile> {
  const root = rootOf(o.baseUrl)
  const http = o.fetch ?? fetch
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = await http(`${root}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': o.apiKey,
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(data.length),
      'x-goog-upload-header-content-type': mime,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  })
  if (!start.ok) throw await fail(start, 'Files API start')
  const target = start.headers.get('x-goog-upload-url')
  if (!target) throw new Error('listen: Files API не дал x-goog-upload-url')
  const up = await http(target, {
    method: 'POST',
    headers: { 'x-goog-upload-offset': '0', 'x-goog-upload-command': 'upload, finalize', 'content-length': String(data.length) },
    body: data as Uint8Array<ArrayBuffer>,
  })
  if (!up.ok) throw await fail(up, 'Files API upload')
  let file = ((await up.json()) as { file?: { name?: string; uri?: string; state?: string; mimeType?: string } }).file
  if (!file?.name || !file.uri) throw new Error('listen: Files API не вернул файл')
  const deadline = Date.now() + (o.timeout ?? 300_000)
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error(`listen: Files API — ${file.name} не обработан за ${Math.round((o.timeout ?? 300_000) / 1000)} с`)
    await sleep(2000)
    const r = await http(`${root}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': o.apiKey } })
    if (!r.ok) throw await fail(r, 'Files API get')
    file = (await r.json()) as typeof file
  }
  if (file.state === 'FAILED') throw new Error(`listen: Files API — обработка ${file.name} не удалась`)
  return { name: file.name!, uri: file.uri!, mime: file.mimeType ?? mime }
}

export async function deleteFile(o: FilesApiOpts, name: string): Promise<void> {
  const http = o.fetch ?? fetch
  const r = await http(`${rootOf(o.baseUrl)}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': o.apiKey } })
  await r.body?.cancel().catch(() => {})
}

/** Звук → формат, который модель берёт: свой — как есть, иначе ffmpeg → mp3. */
export async function prepareAudio(data: Uint8Array, ffmpeg?: FfmpegRun): Promise<{ data: Uint8Array; mime: string; converted: boolean }> {
  const mime = sniffAudio(data)
  if (mime) return { data, mime, converted: false }
  if (!ffmpeg) throw new Error('listen: формат звука не опознан, а ffmpeg не задан')
  const out = await ffmpeg(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], data)
  return { data: out, mime: 'audio/mp3', converted: true }
}

/** ffprobe рядом с ffmpeg (`/opt/homebrew/bin/ffmpeg` → `…/ffprobe`), иначе из PATH. */
export const ffprobeOf = (ffmpeg = 'ffmpeg'): string => (ffmpeg.includes('/') || ffmpeg.includes('\\') ? join(dirname(ffmpeg), basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe')) : 'ffprobe')

/** Длительность звука, с (ffprobe по временному файлу: m4a с moov в конце из трубы не читается). */
export async function audioDuration(data: Uint8Array, ffprobe = 'ffprobe'): Promise<number | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'speak-listen-'))
  const file = join(dir, 'audio')
  try {
    await writeFile(file, data)
    const PATH = [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(delimiter)
    const out = await new Promise<string>((resolve) =>
      execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { env: { ...process.env, PATH }, timeout: 30_000 }, (err, stdout) => resolve(err ? '' : stdout)),
    )
    const n = Number(out.trim())
    return Number.isFinite(n) && n > 0 ? n : undefined
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface Listener {
  engine: SttEngine
  /** Модель с префиксом провайдера (`studio:gemini-3.5-transcribe`). */
  model: string
  /** Распознать байты любого формата: подготовка, inline или Files API (файл удаляется после). */
  transcribe(data: Uint8Array, opts?: TranscribeOpts & { name?: string }): Promise<Listened>
}

export interface Listened extends Transcript {
  /** Перекодирован ffmpeg; ушёл через Files API. */
  converted: boolean
  uploaded: boolean
  /** Длительность звука, с, если задан `duration`. */
  duration?: number | undefined
  /** Слова с таймстемпами не дошли до конца звука и после повтора (обрыв ответа модели). */
  truncated?: boolean | undefined
  /** Запросов к модели (повтор при обрыве — 2). */
  attempts: number
}

/**
 * Ответ с таймстемпами оборван: последнее слово раньше конца звука больше чем на
 * max(15 с, 10 %). Модель (08.10.2026) изредка отдаёт `completed` с половиной слов.
 */
export function truncatedAt(t: Transcript, duration: number | undefined): boolean {
  const last = t.words?.at(-1)?.end
  if (!duration || last === undefined) return false
  return last < duration - Math.max(15, duration * 0.1)
}

export interface ListenerOpts {
  ffmpeg?: FfmpegRun | undefined
  fetch?: typeof fetch | undefined
  /** Порог inline, байт (тесты). */
  inlineMax?: number | undefined
  /** Модель вместо `$listen_model` (`studio:…` или голое имя). */
  model?: string | undefined
  /** Повторы 429 у провайдера (по умолчанию — у движка); 0 — сразу ошибка (есть фолбэк). */
  retries?: number | undefined
  /** Длительность звука, с (лог, verbose_json, проверка обрыва) — `audioDuration` с ffprobe; нет — без неё. */
  duration?: ((data: Uint8Array) => Promise<number | undefined>) | undefined
}

export const LISTEN_ENGINES = ['studio', 'vertex'] as const
export type ListenEngine = (typeof LISTEN_ENGINES)[number]

/** `studio:gemini-3.5-transcribe` → движок и модель; без префикса — studio; пусто — модель по умолчанию движка. */
export function parseListenModel(name: string | undefined): { engine: ListenEngine; model: string } {
  const v = (name ?? '').trim()
  const m = /^([a-z]+):(.*)$/.exec(v)
  if (!m) return { engine: 'studio', model: v || TRANSCRIBE_MODEL }
  if (!(LISTEN_ENGINES as readonly string[]).includes(m[1]!)) throw new Error(`listen: движок «${m[1]}» не поддержан — есть studio: (Gemini API, AI Studio), vertex: (Vertex AI)`)
  const engine = m[1] as ListenEngine
  return { engine, model: m[2]!.trim() || (engine === 'vertex' ? VERTEX_TRANSCRIBE_MODEL : TRANSCRIBE_MODEL) }
}

/** Имя модели без префикса (`studio:x` → `x`); незнакомый движок — ошибка. */
export const listenModelOf = (name: string | undefined): string => parseListenModel(name).model

/**
 * Транскрибер по конфигу: `studio:` — ключ провайдера AI Studio (`$studio_provider`, по умолчанию
 * `google`); `vertex:` — провайдер Vertex (`$vertex_provider`, по умолчанию `vertex`: `$project`,
 * `$location`, `$gcloud`).
 */
export function listenerFromCtx(ctx: unknown, o: ListenerOpts & { token?: (() => Promise<string>) | undefined } = {}): Listener {
  const { engine, model } = parseListenModel(o.model ?? (speakOpt(ctx, 'listen_model') as string | undefined)?.toString())
  if (engine === 'vertex') {
    const pname = (speakOpt(ctx, 'vertex_provider') as string | undefined)?.toString().trim() || 'vertex'
    const p = providerOf(ctx, pname)
    if (!isVertex(p) || !p.project) throw new Error(`listen: нет Vertex ($project в ## $provider ${pname} ~/.runz/config.md)`)
    const stt = createVertexTranscriber({ project: p.project, ...(p.location ? { location: p.location } : {}), ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), token: o.token ?? gcloudToken(p.gcloud), model, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.retries !== undefined ? { retries: o.retries } : {}) })
    return listenerOver(stt, 'vertex', o)
  }
  const pname = (speakOpt(ctx, 'studio_provider') as string | undefined)?.toString().trim() || 'google'
  const p = providerOf(ctx, pname)
  if (!p.apiKey || isVertex(p)) throw new Error(`listen: нет ключа AI Studio ($api_key в ## $provider ${pname} ~/.runz/config.md)`)
  return createListener({ ...o, apiKey: p.apiKey, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), model })
}

/** Транскрибер AI Studio: большой звук — через Files API. */
export function createListener(o: ListenerOpts & { apiKey: string; baseUrl?: string | undefined; model?: string | undefined }): Listener {
  const files: FilesApiOpts = { apiKey: o.apiKey, ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) }
  return listenerOver(createGeminiTranscriber({ ...files, ...(o.model ? { model: o.model } : {}), ...(o.retries !== undefined ? { retries: o.retries } : {}) }), 'studio', o, files)
}

/**
 * Listener над движком: подготовка звука, длительность, повтор при обрыве. `files` — Files API
 * для звука больше `inlineMax` (AI Studio); без него (Vertex) больше порога — 413.
 */
export function listenerOver(engine: SttEngine, prefix: string, o: ListenerOpts, files?: FilesApiOpts): Listener {
  const inlineMax = o.inlineMax ?? INLINE_MAX
  return {
    engine,
    model: `${prefix}:${engine.model}`,
    async transcribe(raw, opts = {}) {
      const a = await prepareAudio(raw, o.ffmpeg)
      const uploaded = a.data.length > inlineMax
      if (uploaded && !files) throw statusError(`listen: ${prefix}:${engine.model} — звук ${Math.round(a.data.length / 1024 / 1024)} МБ, inline до ${Math.round(inlineMax / 1024 / 1024)} МБ`, 413)
      const durationP = o.duration ? o.duration(a.data).catch(() => undefined) : Promise.resolve(undefined)
      const f = uploaded && files ? await uploadFile(files, a.data, a.mime, opts.name ?? 'speak-listen') : undefined
      try {
        const input = f ? { uri: f.uri, mime: a.mime } : { data: a.data, mime: a.mime }
        const [first, duration] = await Promise.all([engine.transcribe(input, opts), durationP])
        let t = first
        let attempts = 1
        if (truncatedAt(t, duration)) {
          attempts++
          const again = await engine.transcribe(input, opts)
          if ((again.words?.at(-1)?.end ?? 0) > (t.words?.at(-1)?.end ?? 0)) t = again
        }
        return { ...t, converted: a.converted, uploaded, attempts, ...(duration !== undefined ? { duration } : {}), ...(truncatedAt(t, duration) ? { truncated: true } : {}) }
      } finally {
        if (f && files) await deleteFile(files, f.name).catch(() => {})
      }
    },
  }
}
