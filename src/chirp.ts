/**
 * Google Cloud Text-to-Speech, голоса Chirp 3 HD (`ru-RU-Chirp3-HD-Aoede`, …): 1M символов
 * в месяц бесплатно. Тот же OAuth-токен и проект, что у Vertex. REST стрима не даёт
 * (стрим — только gRPC), поэтому `text:synthesize` целиком: mp3 — если его просят
 * (`format: 'mp3'`), иначе LINEAR16 (wav 24 кГц). Темп — `speakingRate` (свой).
 */

import type { AudioChunk, SpeakOpts, TtsEngine, VoiceInfo } from './types.js'
import { statusError } from './types.js'

export interface ChirpOpts {
  project: string
  /** Свежий OAuth-токен (тот же, что у Vertex). */
  token: () => Promise<string>
  /** Голос для `voice: ''`. */
  defaultVoice?: string | undefined
  /** Каталог голосов — только этих языков (по умолчанию `ru-RU`). */
  langs?: readonly string[] | undefined
  baseUrl?: string | undefined
  fetch?: typeof fetch | undefined
  /** Сколько держать токен, мс (по умолчанию 50 мин). */
  tokenTtl?: number | undefined
  now?: (() => number) | undefined
}

export const CHIRP_BASE = 'https://texttospeech.googleapis.com'
export const CHIRP_DEFAULT_VOICE = 'ru-RU-Chirp3-HD-Aoede'
/** Лимит одного запроса Cloud TTS — 5000 байт текста. */
export const CHIRP_MAX_BYTES = 5000

/** `ru-RU-Chirp3-HD-Aoede` → `ru-RU`. */
export const chirpLang = (voice: string): string => /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice)?.[1] ?? 'ru-RU'

function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function failure(res: Response, what: string): Promise<Error> {
  let text = ''
  try {
    text = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ''
  } catch {
    // тело не JSON — хватит статуса
  }
  return statusError(`${what}: HTTP ${res.status}${text ? ` — ${text.split('\n')[0]}` : ''}`, res.status)
}

/** Токен на ~50 мин, один запрос за ним на всех ждущих; `fresh` — после 401. */
export function cachedToken(get: () => Promise<string>, ttl = 50 * 60_000, now: () => number = Date.now): (fresh?: boolean) => Promise<string> {
  let cached: { token: Promise<string>; at: number } | null = null
  return (fresh = false) => {
    if (fresh || !cached || now() - cached.at >= ttl) {
      const p = get().then((t) => {
        if (!t.trim()) throw new Error('speak: пустой OAuth-токен')
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

export function createChirpEngine(o: ChirpOpts): TtsEngine {
  const http = o.fetch ?? fetch
  const root = (o.baseUrl ?? CHIRP_BASE).replace(/\/+$/, '')
  const token = cachedToken(o.token, o.tokenTtl, o.now)
  const langs = o.langs ?? ['ru-RU']
  const headers = async (fresh: boolean): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await token(fresh)}`,
    'x-goog-user-project': o.project,
    'content-type': 'application/json',
  })
  /** Запрос с одним обновлением токена на 401. */
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    let res = await http(url, { ...init, headers: await headers(false) })
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {})
      res = await http(url, { ...init, headers: await headers(true) })
    }
    return res
  }
  let catalog: Promise<VoiceInfo[]> | null = null

  return {
    kind: 'chirp',
    limit: 0,
    nativeSpeed: true,
    voices() {
      catalog ??= (async () => {
        const out: VoiceInfo[] = []
        for (const lang of langs) {
          const res = await call(`${root}/v1/voices?languageCode=${encodeURIComponent(lang)}`)
          if (!res.ok) throw await failure(res, 'chirp.voices')
          const body = (await res.json()) as { voices?: { name?: string; ssmlGender?: string; languageCodes?: string[] }[] }
          for (const v of body.voices ?? []) {
            if (!v.name || !/Chirp3-HD/.test(v.name)) continue
            out.push({ id: v.name, type: 'prebuilt', name: v.name, lang: v.languageCodes?.[0] ?? lang, ...(v.ssmlGender ? { gender: v.ssmlGender.toLowerCase() } : {}) })
          }
        }
        return out
      })()
      catalog.catch(() => {
        catalog = null
      })
      return catalog
    },
    async design() {
      throw new Error('chirp.design: у Chirp 3 HD своих голосов нет')
    },
    async *speak(text: string, voiceId: string, opts: SpeakOpts, signal?: AbortSignal): AsyncGenerator<AudioChunk> {
      const voice = voiceId || o.defaultVoice || CHIRP_DEFAULT_VOICE
      const mp3 = opts.format === 'mp3'
      const audioConfig: Record<string, unknown> = { audioEncoding: mp3 ? 'MP3' : 'LINEAR16', sampleRateHertz: 24000 }
      if (opts.speed && opts.speed !== 1) audioConfig.speakingRate = opts.speed
      const body = { input: { text }, voice: { languageCode: chirpLang(voice), name: voice }, audioConfig }
      const res = await call(`${root}/v1/text:synthesize`, { method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) })
      if (!res.ok) throw await failure(res, 'chirp.speak')
      const content = ((await res.json()) as { audioContent?: string }).audioContent
      if (!content) throw new Error('chirp.speak: провайдер не вернул звука')
      yield { data: b64decode(content), mime: mp3 ? 'audio/mpeg' : 'audio/wav' }
    },
  }
}
