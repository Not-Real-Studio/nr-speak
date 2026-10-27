/**
 * Локальные движки (DEV-520): OmniVoice на лаптопе (GPU) и PocketTTS-RU на m2 (CPU) — свой
 * сервер `serve/local_tts.py`, OpenAI-совместимый `POST /v1/audio/speech` с потоком PCM s16le
 * 24 кГц. Голос движка:
 *
 *   ''                 — голос сервера по умолчанию (`--default-voice`)
 *   `design:<атрибуты>` — OmniVoice: голос по описанию (`male, low pitch`); pocket — по умолчанию
 *   путь к образцу     — клон (`~/…/denis-11s.wav`, текст образца — `<тот же путь>.txt`): образец
 *                        грузится на сервер один раз (`PUT /v1/voices/<хэш>`), дальше идёт хэш;
 *                        сервер держит подготовленный промпт в памяти
 *   иначе              — id образца, уже лежащего на сервере
 *
 * `createFallbackEngine` — автопереход: основной не ответил первым звуком за порог (или упал до
 * первого звука) — та же фраза запасным, основной пропускается `cooldownMs`. Звук запасного
 * помечен `fallback` — speaker его не кэширует под ключом основного.
 */

import type { AudioChunk, SpeakOpts, TtsEngine, VoiceInfo } from './types.js'
import { statusError } from './types.js'

export const LOCAL_ENGINES = ['omnivoice', 'pocket'] as const
export type LocalKind = (typeof LOCAL_ENGINES)[number]

/** Образец клона: WAV и текст того, что в нём сказано (OmniVoice без текста зовёт ASR). */
export interface LocalSample {
  audio: Uint8Array
  text?: string | undefined
}

export interface LocalEngineOpts {
  kind: LocalKind
  /** Корень сервера (`http://laptop:8095`), с `/v1` или без. */
  baseUrl: string
  apiKey?: string | undefined
  /** Образец по пути (Node — `fileSampleLoader`); нет — пути как голоса не поддерживаются. */
  loadSample?: ((ref: string) => Promise<LocalSample>) | undefined
  fetch?: typeof fetch | undefined
  /** Порог соединения и заголовка ответа, мс (по умолчанию 30 000 — долгий синтез не рвём). */
  timeoutMs?: number | undefined
}

const PCM_MIME = 'audio/l16; rate=24000; channels=1'

/** Путь к образцу, а не id на сервере. */
export const isSampleRef = (voice: string): boolean => /^(~|\/|[A-Za-z]:[\\/]|\.\.?\/)/.test(voice) || /\.(wav|flac|mp3|m4a|ogg)$/i.test(voice)

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Id образца на сервере: хэш звука и текста — правка файла даёт новый образец. */
export async function sampleId(s: LocalSample): Promise<string> {
  const text = new TextEncoder().encode(`\u0000${s.text ?? ''}`)
  const all = new Uint8Array(s.audio.length + text.length)
  all.set(s.audio)
  all.set(text, s.audio.length)
  return `s-${hex(await crypto.subtle.digest('SHA-256', all)).slice(0, 24)}`
}

function b64(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(s)
}

const root = (u: string): string => u.replace(/\/+$/, '').replace(/\/v1$/, '')

export function createLocalEngine(o: LocalEngineOpts): TtsEngine {
  const http = o.fetch ?? fetch
  const base = root(o.baseUrl)
  const auth = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}
  // Путь → id образца, загруженного на сервер (промис: параллельные фразы грузят один раз).
  const uploaded = new Map<string, Promise<string>>()

  async function upload(ref: string, signal?: AbortSignal): Promise<string> {
    if (!o.loadSample) throw new Error(`${o.kind}: голос-путь «${ref}» — загрузчик образцов не подключён`)
    const s = await o.loadSample(ref)
    const id = await sampleId(s)
    const res = await http(`${base}/v1/voices/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ audio: b64(s.audio), text: s.text ?? '' }),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) throw statusError(`${o.kind}: образец «${ref}» не принят: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`, res.status)
    return id
  }

  const idOf = (ref: string, signal?: AbortSignal): Promise<string> => {
    let p = uploaded.get(ref)
    if (!p) {
      p = upload(ref, signal)
      uploaded.set(ref, p)
      p.catch(() => uploaded.delete(ref))
    }
    return p
  }

  async function post(text: string, voice: string, opts: SpeakOpts, signal?: AbortSignal): Promise<Response> {
    const body: Record<string, unknown> = { model: o.kind, input: text, voice, response_format: 'pcm' }
    if (opts.instruct?.trim()) body.instructions = opts.instruct.trim()
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 30_000)
    return http(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  }

  return {
    kind: o.kind,
    limit: 0,
    async voices(): Promise<VoiceInfo[]> {
      const res = await http(`${base}/v1/audio/voices`, { headers: auth, signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw statusError(`${o.kind}.voices: HTTP ${res.status}`, res.status)
      const j = (await res.json()) as { voices?: { id: string }[] }
      return (j.voices ?? []).map((v) => ({ id: v.id, type: 'prebuilt', name: v.id, lang: 'ru-RU' }))
    },
    async design() {
      throw new Error(`${o.kind}.design: голос по описанию — \`design:<атрибуты>\` прямо в имени голоса`)
    },
    async *speak(text: string, voiceId: string, opts: SpeakOpts, signal?: AbortSignal): AsyncGenerator<AudioChunk> {
      let v = voiceId.trim()
      // Дизайна у pocket нет: его голос по умолчанию.
      if (o.kind === 'pocket' && v.startsWith('design:')) v = ''
      const ref = isSampleRef(v) ? v : ''
      if (ref) v = await idOf(ref, signal)
      let res = await post(text, v, opts, signal)
      // Сервер потерял образец (сменили каталог данных) — загрузить заново, один раз.
      if (res.status === 404 && ref) {
        await res.text().catch(() => '')
        uploaded.delete(ref)
        v = await idOf(ref, signal)
        res = await post(text, v, opts, signal)
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw statusError(`${o.kind}.speak: HTTP ${res.status}${t ? ` — ${t.slice(0, 200)}` : ''}`, res.status)
      }
      const reader = res.body?.getReader()
      if (!reader) {
        const data = new Uint8Array(await res.arrayBuffer())
        if (!data.length) throw new Error(`${o.kind}.speak: пустой ответ`)
        yield { data, mime: PCM_MIME }
        return
      }
      let total = 0
      let carry: Uint8Array | null = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        let data: Uint8Array = carry ? join(carry, value) : value
        carry = null
        if (data.length % 2) {
          carry = data.subarray(data.length - 1)
          data = data.subarray(0, data.length - 1)
        }
        if (!data.length) continue
        total += data.length
        yield { data, mime: PCM_MIME }
      }
      if (!total) throw new Error(`${o.kind}.speak: пустой ответ`)
    },
  }
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

export interface FallbackOpts {
  /** Нет первого звука за столько мс — запасной (по умолчанию 2000). */
  firstAudioMs?: number | undefined
  /** После сбоя основной пропускается столько мс (по умолчанию 60 000). */
  cooldownMs?: number | undefined
  /** Имя запасного в пометке `fallback` (по умолчанию его `kind`). */
  backupName?: string | undefined
  onFallback?: ((e: { reason: string; skipped: boolean }) => void) | undefined
  now?: (() => number) | undefined
}

/**
 * Основной с автопереходом на запасной. Переход — только до первого звука: начатую фразу
 * основной договаривает сам (обрыв посреди — ошибка, как у любого движка).
 */
export function createFallbackEngine(primary: TtsEngine, backup: TtsEngine, o: FallbackOpts = {}): TtsEngine {
  const firstMs = o.firstAudioMs ?? 2000
  const cooldown = o.cooldownMs ?? 60_000
  const now = o.now ?? Date.now
  const name = o.backupName ?? backup.kind ?? 'backup'
  let downUntil = 0

  async function* viaBackup(text: string, voiceId: string, opts: SpeakOpts, signal?: AbortSignal): AsyncGenerator<AudioChunk> {
    for await (const c of backup.speak(text, voiceId, opts, signal)) yield { ...c, fallback: name }
  }

  return {
    ...(primary.kind ? { kind: primary.kind } : {}),
    limit: primary.limit ?? 0,
    ...(primary.nativeSpeed && backup.nativeSpeed ? { nativeSpeed: true } : {}),
    async voices(opts) {
      try {
        return await primary.voices(opts)
      } catch {
        return backup.voices(opts)
      }
    },
    design: (spec) => primary.design(spec),
    async *speak(text: string, voiceId: string, opts: SpeakOpts, signal?: AbortSignal): AsyncGenerator<AudioChunk> {
      if (now() < downUntil) {
        o.onFallback?.({ reason: 'cooldown', skipped: true })
        return yield* viaBackup(text, voiceId, opts, signal)
      }
      const ac = new AbortController()
      const onAbort = (): void => ac.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const it = primary.speak(text, voiceId, opts, ac.signal)[Symbol.asyncIterator]()
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), firstMs)))
      let first: IteratorResult<AudioChunk> | 'late'
      try {
        const next = it.next()
        // Опоздавший ответ основного после перехода не должен всплыть необработанным.
        next.catch(() => {})
        first = await Promise.race([next, late])
      } catch (err) {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) throw err
        downUntil = now() + cooldown
        o.onFallback?.({ reason: String((err as Error)?.message ?? err), skipped: false })
        return yield* viaBackup(text, voiceId, opts, signal)
      }
      clearTimeout(timer)
      if (first === 'late') {
        signal?.removeEventListener('abort', onAbort)
        ac.abort()
        void it.return?.(undefined).catch(() => {})
        downUntil = now() + cooldown
        o.onFallback?.({ reason: `нет звука за ${firstMs} мс`, skipped: false })
        return yield* viaBackup(text, voiceId, opts, signal)
      }
      try {
        for (let n = first; !n.done; n = await it.next()) yield n.value
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
