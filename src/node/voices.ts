/**
 * Голоса на диске (voice-lab-spec §2–3): коллекция `envs/voices/<slug>.mdz` (один файл — один
 * голос, `@<slug>` у всех потребителей speak), кэш библиотеки AI Studio на сутки, чистка образца
 * клона ffmpeg.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CollectionVoice, VoiceCollection } from '../speaker.js'
import type { FfmpegRun } from '../audio.js'
import { concat, wavHeader } from '../audio.js'
import type { LibraryCache, VoiceInfo } from '../types.js'

export const VOICES_DIR = join(homedir(), 'Studio', 'envs', 'voices')

/** Запись коллекции целиком (поля файла без `$`). */
export interface CollectionEntry extends CollectionVoice {
  name?: string
  description?: string
  type?: string
  lang?: string
  gender?: string
  pitch?: string
  design?: string
  source?: string
  consent?: string
  raw?: string
  sample?: string
  tags?: string[]
  note?: string
  tried?: string
  /** Запасные голоса (`$fallback: openai:vertex:Sulafat, say:Milena`, DEV-547). */
  fallback?: string[]
  /** Прочие поля файла как есть. */
  extra: Record<string, string | string[]>
}

const KNOWN = ['name', 'description', 'engine', 'voice', 'type', 'lang', 'gender', 'pitch', 'design', 'source', 'consent', 'raw', 'sample', 'tags', 'note', 'tried', 'style', 'fallback'] as const

/** Плоский mdz голоса: `$ключ: значение`, `$[a, b]` — список, `$//` — комментарий. */
export function parseVoiceMdz(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  let last = ''
  for (const line of src.split(/\r?\n/)) {
    const m = /^\$([\w-]+):\s?(.*)$/.exec(line)
    if (m) {
      last = m[1]!
      const v = m[2]!.trim()
      const arr = /^\$\[(.*)\]$/.exec(v)
      out[last] = arr ? arr[1]!.split(',').map((x) => x.trim()).filter(Boolean) : v
    } else if (last && line.startsWith('  ') && typeof out[last] === 'string') {
      // продолжение многострочного значения
      out[last] = `${out[last] as string}\n${line.trim()}`
    } else if (!line.startsWith('$//')) last = ''
  }
  return out
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.join(', ') : v?.trim() || undefined)

export function entryOf(slug: string, src: string): CollectionEntry | undefined {
  const raw = parseVoiceMdz(src)
  const engine = one(raw.engine)
  const voice = one(raw.voice)
  if (!engine || !voice) return undefined
  const e: CollectionEntry = { slug, engine, voice, extra: {} }
  for (const k of KNOWN) {
    if (k === 'engine' || k === 'voice') continue
    const v = raw[k]
    if (v === undefined) continue
    if (k === 'tags' || k === 'fallback') e[k] = Array.isArray(v) ? v : v.split(/[,→]/).map((x) => x.trim()).filter(Boolean)
    else (e as unknown as Record<string, string>)[k] = one(v)!
  }
  for (const [k, v] of Object.entries(raw)) if (!(KNOWN as readonly string[]).includes(k)) e.extra[k] = v
  return e
}

/** Значение mdz одной строкой: переводы строк — пробелом (формат плоский). */
const flat = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()

/** Запись → текст mdz (порядок — как в спеке, прочие поля в конце). */
export function voiceMdz(e: Omit<CollectionEntry, 'slug' | 'extra'> & { extra?: Record<string, string | string[]> }): string {
  const lines: string[] = []
  const put = (k: string, v: string | string[] | undefined): void => {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return
    lines.push(`$${k}: ${Array.isArray(v) ? `$[${v.join(', ')}]` : flat(v)}`)
  }
  put('name', e.name)
  put('description', e.description)
  put('engine', e.engine)
  put('voice', e.voice)
  put('type', e.type)
  put('lang', e.lang)
  put('gender', e.gender)
  put('pitch', e.pitch)
  put('design', e.design)
  put('source', e.source)
  put('consent', e.consent)
  put('raw', e.raw)
  put('sample', e.sample)
  put('fallback', e.fallback)
  put('style', e.style)
  put('tags', e.tags)
  put('note', e.note)
  put('tried', e.tried)
  for (const [k, v] of Object.entries(e.extra ?? {})) put(k, v)
  return `${lines.join('\n')}\n`
}

/** Слаг из имени: латиница/цифры/дефис, кириллица транслитом. */
export function slugOf(name: string): string {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }
  return name
    .toLowerCase()
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

export interface FileCollection extends VoiceCollection {
  readonly dir: string
  get(slug: string): Promise<CollectionEntry | undefined>
  list(): Promise<CollectionEntry[]>
  /** Записать голос (новый или правка); слаг — из `slug` или имени, занятый — с номером. */
  save(e: Omit<CollectionEntry, 'slug' | 'extra'> & { slug?: string; extra?: Record<string, string | string[]> }, o?: { overwrite?: boolean }): Promise<CollectionEntry>
  remove(slug: string): Promise<boolean>
  /** Правка полей на месте: строка `$ключ:` заменяется, нет — дописывается; комментарии `$//` живут. `''` — убрать поле. */
  update(slug: string, fields: Record<string, string | string[]>): Promise<CollectionEntry>
  /** Слаг голоса по `engine:voice` (избранный ли). */
  find(engine: string, voice: string): Promise<CollectionEntry | undefined>
}

const SAFE = /^[a-z0-9][a-z0-9-]*$/

/** Коллекция на каталоге `envs/voices` (читается на каждый вызов — правки руками видны сразу). */
export function fileCollection(dir = VOICES_DIR): FileCollection {
  const file = (slug: string): string => {
    if (!SAFE.test(slug)) throw new Error(`speak: слаг голоса «${slug}» — только a-z, 0-9, дефис`)
    return join(dir, `${slug}.mdz`)
  }
  const get = async (slug: string): Promise<CollectionEntry | undefined> => {
    const f = file(slug)
    return existsSync(f) ? entryOf(slug, readFileSync(f, 'utf8')) : undefined
  }
  const list = async (): Promise<CollectionEntry[]> => {
    if (!existsSync(dir)) return []
    const out: CollectionEntry[] = []
    for (const f of readdirSync(dir).sort((a, b) => a.slice(0, -4).localeCompare(b.slice(0, -4)))) {
      if (!f.endsWith('.mdz')) continue
      const slug = f.slice(0, -4)
      if (!SAFE.test(slug)) continue
      const e = entryOf(slug, readFileSync(join(dir, f), 'utf8'))
      if (e) out.push(e)
    }
    return out
  }
  return {
    dir,
    get,
    list,
    async find(engine, voice) {
      return (await list()).find((e) => e.engine === engine && e.voice === voice)
    },
    async save(e, o = {}) {
      let slug = e.slug ? e.slug : slugOf(e.name ?? e.voice) || 'voice'
      if (!o.overwrite) for (let i = 2; existsSync(file(slug)); i++) slug = `${e.slug ?? (slugOf(e.name ?? e.voice) || 'voice')}-${i}`
      const f = file(slug)
      mkdirSync(dirname(f), { recursive: true })
      const tmp = `${f}.${process.pid}.tmp`
      writeFileSync(tmp, voiceMdz(e))
      renameSync(tmp, f)
      return (await get(slug))!
    },
    async update(slug, fields) {
      const f = file(slug)
      if (!existsSync(f)) throw new Error(`speak: в коллекции нет голоса «${slug}»`)
      const lines = readFileSync(f, 'utf8').replace(/\n$/, '').split('\n')
      for (const [k, v] of Object.entries(fields)) {
        if (!/^[\w-]+$/.test(k)) throw new Error(`speak: поле «${k}»`)
        const at = lines.findIndex((l) => l.startsWith(`$${k}:`))
        const empty = v === '' || (Array.isArray(v) && !v.length)
        const line = `$${k}: ${Array.isArray(v) ? `$[${v.join(', ')}]` : flat(v)}`
        if (at >= 0) {
          let end = at + 1
          while (end < lines.length && lines[end]!.startsWith('  ')) end++
          lines.splice(at, end - at, ...(empty ? [] : [line]))
        } else if (!empty) lines.push(line)
      }
      const tmp = `${f}.${process.pid}.tmp`
      writeFileSync(tmp, `${lines.join('\n')}\n`)
      renameSync(tmp, f)
      return (await get(slug))!
    },
    async remove(slug) {
      const f = file(slug)
      if (!existsSync(f)) return false
      unlinkSync(f)
      return true
    },
  }
}

/** Кэш библиотеки на json-файле, `ttl` — сутки. */
export function fileLibraryCache(file: string, ttl = 24 * 3600_000, now: () => number = Date.now): LibraryCache {
  return {
    async get() {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8')) as { at: number; voices: VoiceInfo[] }
        return now() - j.at < ttl ? j.voices : undefined
      } catch {
        return undefined
      }
    },
    async set(voices) {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ at: now(), voices }))
      renameSync(tmp, file)
    },
  }
}

/** Фильтр чистки записи для клона (тихий Диктофон −42 дБ: иначе согласие не распознаётся). */
export const CLEAN_FILTER = 'highpass=f=80,lowpass=f=11000,afftdn=nr=18,loudnorm=I=-20:TP=-2:LRA=11'

/**
 * Запись (m4a, wav, что угодно) → WAV 24 кГц моно s16 с честным заголовком, чистка `CLEAN_FILTER`
 * (`clean: false` — без неё). Вход — временным файлом: m4a с Диктофона держит moov в конце, из
 * трубы ffmpeg его не читает (пустой звук).
 */
export async function cleanSample(ffmpeg: FfmpegRun, audio: Uint8Array, o: { clean?: boolean } = {}): Promise<Uint8Array> {
  const af = o.clean === false ? [] : ['-af', CLEAN_FILTER]
  const dir = mkdtempSync(join(tmpdir(), 'speak-sample-'))
  const file = join(dir, 'in')
  try {
    writeFileSync(file, audio)
    const out = await ffmpeg(['-i', file, ...af, '-ar', '24000', '-ac', '1', '-sample_fmt', 's16', '-f', 's16le', 'pipe:1'], new Uint8Array())
    if (out.length < 24000 * 2) throw new Error(`speak: в записи меньше секунды звука (${out.length} байт после ffmpeg)`)
    return concat([wavHeader(24000, out.length), out])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
