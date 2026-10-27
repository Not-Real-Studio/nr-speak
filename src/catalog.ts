/**
 * Каталог голосов всех настроенных движков и резолв имён. Полное имя — с префиксом
 * движка: `vertex:Kore`, `studio:voice_…`, `chirp:ru-RU-Chirp3-HD-Aoede`,
 * `edge:ru-RU-SvetlanaNeural`, `openai:<голос>`, `say:Milena` (macOS, без сети), `omnivoice:<образец>` и
 * `pocket:<образец>` (свои серверы, DEV-520). Короткое имя ищется по порядку
 * Vertex → Studio → Chirp → Edge → OpenAI: точное совпадение id (без регистра), затем
 * однозначное совпадение части id (`Svetlana` → `ru-RU-SvetlanaNeural`, `Aoede` в Chirp —
 * только с префиксом, иначе это студийный голос Vertex).
 */

import { STUDIO_VOICES, VERTEX_NO_LIBRARY, studioVoice } from './gemini.js'
import type { TtsEngine, VoiceInfo } from './types.js'

export const ENGINE_NAMES = ['vertex', 'studio', 'chirp', 'edge', 'openai', 'say', 'omnivoice', 'pocket'] as const
export type EngineName = (typeof ENGINE_NAMES)[number]
export type Tier = 'free' | 'cheap' | 'premium' | 'local'

export const ENGINE_TIER: Record<EngineName, Tier> = { vertex: 'premium', studio: 'cheap', chirp: 'free', edge: 'free', openai: 'local', say: 'local', omnivoice: 'local', pocket: 'local' }

/** Настроенные движки по имени; отсутствующий — не настроен. */
export type Engines = Partial<Record<EngineName, TtsEngine>>

export interface CatalogVoice {
  /** Полное имя: `vertex:Kore`. */
  id: string
  engine: EngineName
  /** Голос внутри движка: `Kore`. */
  voice: string
  lang?: string
  gender?: string
  tier: Tier
  /** Описание своего голоса (Voice design). */
  design?: string
  /** Избранный (список — из конфига, `$speak_favorites`). */
  favorite?: true
}

export interface Resolved {
  engine: EngineName
  voice: string
}

export const isEngineName = (s: string): s is EngineName => (ENGINE_NAMES as readonly string[]).includes(s)

/** Узнаётся по виду без сети: так короткое имя не дёргает каталоги лишний раз. */
const SHAPE: Partial<Record<EngineName, RegExp>> = { studio: /^voice_/, chirp: /Chirp3-HD/i, edge: /Neural$/i }

const tokens = (id: string): string[] => id.toLowerCase().replace(/neural$/, '').split(/[-_\s]+/).filter(Boolean)

/** Голос внутри списка: точный id, иначе однозначная часть id. */
export function matchVoice(ids: readonly string[], name: string): string | undefined {
  const n = name.toLowerCase()
  const exact = ids.find((id) => id.toLowerCase() === n)
  if (exact) return exact
  const part = ids.filter((id) => tokens(id).includes(n))
  if (part.length > 1) throw new Error(`speak: голос «${name}» неоднозначен: ${part.join(', ')}`)
  return part[0]
}

async function idsOf(name: EngineName, engine: TtsEngine): Promise<string[]> {
  if (name === 'vertex') return STUDIO_VOICES.map((v) => v.id)
  const list = await engine.voices(name === 'studio' ? {} : { prebuilt: true })
  return list.filter((v) => name !== 'studio' || v.type !== 'prebuilt').map((v) => v.id)
}

/**
 * Имя голоса → движок и голос. `defaultVoice` — для пустого имени (`vertex:Kore`);
 * `engine` — явный движок (короткое имя ищется только в нём).
 */
export async function resolveVoice(engines: Engines, name: string | undefined, o: { engine?: string | undefined; defaultVoice?: string | undefined } = {}): Promise<Resolved> {
  const raw = (name ?? '').trim()
  if (!raw) {
    if (o.engine) {
      if (!isEngineName(o.engine) || !engines[o.engine]) throw new Error(`speak: движок «${o.engine}» не настроен (есть: ${configured(engines)})`)
      if (o.defaultVoice && o.defaultVoice.startsWith(`${o.engine}:`)) return resolveVoice(engines, o.defaultVoice)
      return { engine: o.engine, voice: '' }
    }
    if (!o.defaultVoice) throw new Error('speak: голос не задан и голоса по умолчанию нет')
    return resolveVoice(engines, o.defaultVoice)
  }
  const colon = raw.indexOf(':')
  const prefix = colon > 0 ? raw.slice(0, colon) : ''
  if (prefix && isEngineName(prefix)) return within(engines, prefix, raw.slice(colon + 1))
  if (o.engine) {
    if (!isEngineName(o.engine)) throw new Error(`speak: неизвестный движок «${o.engine}» (${ENGINE_NAMES.join(', ')})`)
    return within(engines, o.engine, raw)
  }
  // По виду — без сети.
  if (STUDIO_VOICES.some((v) => v.id.toLowerCase() === raw.toLowerCase()) && engines.vertex) return within(engines, 'vertex', raw)
  for (const n of ENGINE_NAMES) if (SHAPE[n]?.test(raw) && engines[n]) return within(engines, n, raw)
  for (const n of ENGINE_NAMES) {
    const e = engines[n]
    if (!e) continue
    const hit = matchVoice(await idsOf(n, e).catch(() => []), raw)
    if (hit) return { engine: n, voice: hit }
  }
  // Последним — библиотека AI Studio по id или имени (`Neno`, `Neno (ja-JP)`).
  const lib = engines.studio?.library ? await engines.studio.library().catch(() => []) : []
  const fromLib = matchLibrary(lib, raw)
  if (fromLib) return { engine: 'studio', voice: fromLib.id }
  throw new Error(`speak: голос «${raw}» не найден ни в одном движке (${configured(engines)}); полный список — voices`)
}

async function within(engines: Engines, n: EngineName, voice: string): Promise<Resolved> {
  const e = engines[n]
  if (!e) throw new Error(`speak: движок «${n}» не настроен (есть: ${configured(engines)})`)
  if (!voice) return { engine: n, voice: '' }
  // Studio: свой `voice_…` и студийный — как есть; иначе — библиотека (id или имя), не нашлось — как есть.
  if (n === 'studio') {
    if (voice.startsWith('voice_') || studioVoice(voice) || !e.library) return { engine: n, voice }
    const hit = matchLibrary(await e.library(), voice)
    return { engine: n, voice: hit?.id ?? voice }
  }
  // OpenAI и локальные — как есть: список не обязан быть полным (у локальных голос — путь к образцу или `design:`).
  if (n === 'openai' || n === 'omnivoice' || n === 'pocket') return { engine: n, voice }
  const ids = await idsOf(n, e)
  const hit = matchVoice(ids, voice)
  if (!hit && n === 'vertex' && /^[a-z]{2,3}-[a-z0-9]+-/.test(voice)) throw new Error(`speak: ${VERTEX_NO_LIBRARY(voice)}`)
  if (!hit) throw new Error(`speak: у движка ${n} нет голоса «${voice}»`)
  return { engine: n, voice: hit }
}

/**
 * Голос библиотеки по id (`ja-jp-neno`, без регистра) или имени (`display_name`); одно имя у
 * нескольких языков — нужен язык: `Neno (ja-JP)` или `ja-JP/Neno`, иначе ошибка со списком.
 */
export function matchLibrary(list: readonly VoiceInfo[], name: string): VoiceInfo | undefined {
  const n = name.trim().toLowerCase()
  const byId = list.find((v) => v.id.toLowerCase() === n)
  if (byId) return byId
  const m = /^(.+?)\s*\(([a-z]{2,3}(?:-[a-z0-9]+)?)\)$/i.exec(name.trim()) ?? /^([a-z]{2,3}-[a-z0-9]+)\/(.+)$/i.exec(name.trim())
  const [who, lang] = m ? (m[0].includes('/') ? [m[2]!, m[1]!] : [m[1]!, m[2]!]) : [name.trim(), '']
  const hits = list.filter((v) => (v.name ?? '').toLowerCase() === who.toLowerCase() && (!lang || (v.lang ?? '').toLowerCase() === lang.toLowerCase()))
  if (hits.length > 1) throw new Error(`speak: голос «${name}» есть в нескольких языках: ${hits.map((v) => `${v.name} (${v.lang}) = ${v.id}`).join(', ')}`)
  return hits[0]
}

export interface LibraryFilter {
  gender?: string | undefined
  /** Префикс языка: `ja`, `ja-JP`. */
  lang?: string | undefined
  /** Подстрока в id, имени, описании, амплуа, акценте. */
  q?: string | undefined
}

/** Библиотека с фильтром (CLI `voices --library`, стенд). */
export function filterLibrary(list: readonly VoiceInfo[], f: LibraryFilter): VoiceInfo[] {
  const q = f.q?.trim().toLowerCase()
  const lang = f.lang?.trim().toLowerCase()
  const gender = f.gender?.trim().toLowerCase()
  return list.filter(
    (v) =>
      (!gender || (v.gender ?? '').toLowerCase() === gender) &&
      (!lang || (v.lang ?? '').toLowerCase().startsWith(lang)) &&
      (!q || [v.id, v.name, v.description, v.persona, v.accent, v.context].some((x) => x?.toLowerCase().includes(q))),
  )
}

const configured = (engines: Engines): string => ENGINE_NAMES.filter((n) => engines[n]).join(', ') || 'ни одного'

/**
 * Избранный ли голос: элемент списка — полное имя (`vertex:Sulafat`) или голос без префикса
 * (`Sulafat` — совпадение по id внутри любого движка, без регистра).
 */
export function isFavorite(v: { id: string; voice: string }, favorites: readonly string[]): boolean {
  const id = v.id.toLowerCase()
  const voice = v.voice.toLowerCase()
  return favorites.some((f) => {
    const x = f.trim().toLowerCase()
    return x === id || x === voice
  })
}

/** Каталог: голоса всех (или одного) движков; упавший движок — в `errors`, остальные отдаются. */
export async function catalog(engines: Engines, o: { engine?: string | undefined; favorites?: readonly string[] | undefined } = {}): Promise<{ voices: CatalogVoice[]; errors: { engine: EngineName; error: string }[] }> {
  if (o.engine && (!isEngineName(o.engine) || !engines[o.engine])) throw new Error(`speak: движок «${o.engine}» не настроен (есть: ${configured(engines)})`)
  const names = ENGINE_NAMES.filter((n) => engines[n] && (!o.engine || o.engine === n))
  const voices: CatalogVoice[] = []
  const errors: { engine: EngineName; error: string }[] = []
  await Promise.all(
    names.map(async (n) => {
      try {
        const e = engines[n]!
        const list = n === 'vertex' ? await e.voices({ prebuilt: true }) : (await e.voices(n === 'studio' ? {} : { prebuilt: true })).filter((v) => n !== 'studio' || v.type !== 'prebuilt')
        for (const v of list) {
          voices.push({
            id: `${n}:${v.id}`,
            engine: n,
            voice: v.id,
            tier: ENGINE_TIER[n],
            ...(v.lang ? { lang: v.lang } : n === 'vertex' || n === 'studio' ? { lang: 'multi' } : {}),
            ...(v.gender ? { gender: v.gender } : {}),
            ...(v.design ? { design: v.design } : {}),
            ...(o.favorites && isFavorite({ id: `${n}:${v.id}`, voice: v.id }, o.favorites) ? { favorite: true as const } : {}),
          })
        }
      } catch (err) {
        errors.push({ engine: n, error: String((err as Error)?.message ?? err) })
      }
    }),
  )
  // Избранные — первыми (в порядке списка), дальше — по движку и имени.
  const rank = (v: CatalogVoice): number => (v.favorite && o.favorites ? o.favorites.findIndex((f) => isFavorite(v, [f])) : Infinity)
  voices.sort((a, b) => rank(a) - rank(b) || ENGINE_NAMES.indexOf(a.engine) - ENGINE_NAMES.indexOf(b.engine) || a.voice.localeCompare(b.voice))
  return { voices, errors }
}
