/**
 * Речь → текст, Node-половина (DEV-252): звук любого формата → поддерживаемый (ffmpeg),
 * маленький — inline, большой (митинги) — Files API Gemini; длительность — ffprobe;
 * транскрибер по конфигу runz (`## $speak` → `$listen_model`, ключ — провайдер AI Studio).
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import type { FfmpegRun } from '../audio.js'
import type { SttEngine, Transcript, TranscribeOpts } from '../stt.js'
import { TRANSCRIBE_MODEL, createGeminiTranscriber, sniffAudio } from '../stt.js'
import { isVertex, providerOf, speakOpt } from './config.js'

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
  transcribe(data: Uint8Array, opts?: TranscribeOpts & { name?: string }): Promise<Transcript & { converted: boolean; uploaded: boolean }>
}

export interface ListenerOpts {
  ffmpeg?: FfmpegRun | undefined
  fetch?: typeof fetch | undefined
  /** Порог inline, байт (тесты). */
  inlineMax?: number | undefined
  /** Модель вместо `$listen_model` (`studio:…` или голое имя). */
  model?: string | undefined
}

/** `studio:gemini-3.5-transcribe` → имя модели; другой провайдер — ошибка (пока есть только studio). */
export function listenModelOf(name: string | undefined): string {
  const v = (name ?? '').trim()
  if (!v) return TRANSCRIBE_MODEL
  const m = /^([a-z]+):(.+)$/.exec(v)
  if (!m) return v
  if (m[1] !== 'studio') throw new Error(`listen: движок «${m[1]}» не поддержан — есть studio: (Gemini API, AI Studio)`)
  return m[2]!
}

/** Транскрибер по конфигу: ключ — провайдер AI Studio (`$studio_provider`, по умолчанию `google`). */
export function listenerFromCtx(ctx: unknown, o: ListenerOpts = {}): Listener {
  const pname = (speakOpt(ctx, 'studio_provider') as string | undefined)?.toString().trim() || 'google'
  const p = providerOf(ctx, pname)
  if (!p.apiKey || isVertex(p)) throw new Error(`listen: нет ключа AI Studio ($api_key в ## $provider ${pname} ~/.runz/config.md)`)
  const model = listenModelOf(o.model ?? (speakOpt(ctx, 'listen_model') as string | undefined)?.toString())
  return createListener({ ...o, apiKey: p.apiKey, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), model })
}

export function createListener(o: ListenerOpts & { apiKey: string; baseUrl?: string | undefined; model?: string | undefined }): Listener {
  const files: FilesApiOpts = { apiKey: o.apiKey, ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) }
  const engine = createGeminiTranscriber({ ...files, ...(o.model ? { model: o.model } : {}) })
  const inlineMax = o.inlineMax ?? INLINE_MAX
  return {
    engine,
    model: `studio:${engine.model}`,
    async transcribe(raw, opts = {}) {
      const a = await prepareAudio(raw, o.ffmpeg)
      if (a.data.length <= inlineMax) return { ...(await engine.transcribe({ data: a.data, mime: a.mime }, opts)), converted: a.converted, uploaded: false }
      const f = await uploadFile(files, a.data, a.mime, opts.name ?? 'speak-listen')
      try {
        return { ...(await engine.transcribe({ uri: f.uri, mime: a.mime }, opts)), converted: a.converted, uploaded: true }
      } finally {
        await deleteFile(files, f.name).catch(() => {})
      }
    },
  }
}
