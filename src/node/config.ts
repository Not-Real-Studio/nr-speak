/**
 * Конфиг движков из цепочки runz (`~/.runz/config.md`) — перенос разбора провайдеров и
 * токена из `nrchat/plugins/voice/service.ts` (DEV-247, поведение без изменений:
 * `providerOf`, `engineFromCtx`, `gcloudToken`, `fileCache`) плюс сборка всех движков
 * speak (`enginesFromCtx`). В коде ключей и путей нет — всё из конфига.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import type { LibraryCache, TtsEngine, VoiceCache } from '../types.js'
import { createGeminiEngine, createRoutedEngine, createVertexEngine } from '../gemini.js'
import type { EngineName, Engines } from '../catalog.js'
import { createChirpEngine } from '../chirp.js'
import type { EdgeClient } from '../edge.js'
import { createEdgeEngine } from '../edge.js'
import { createOpenAIEngine } from '../openai.js'
import { createSayEngine, hasSay } from './say.js'

/** Структурно — `IContext` runz: сервису нужен только `get`. */
interface Ctx {
  get(path: string[]): unknown
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

function ctxGet(ctx: unknown, path: string[]): unknown {
  const get = (ctx as Partial<Ctx> | null)?.get
  return typeof get === 'function' ? get.call(ctx, path) : undefined
}

export interface VoiceProvider {
  apiKey?: string
  baseUrl?: string
  /** Vertex: проект GCP, регион, путь к gcloud. */
  project?: string
  location?: string
  gcloud?: string
  /** `$engine` (или `$type`) блока: `vertex` | `gemini`. */
  engine?: string
}

/** `## $provider <name>` цепочки: `base_url`, `api_key` (как `resolveProviderConfig` nr-engine) + поля Vertex. */
export function providerOf(ctx: unknown, name: string): VoiceProvider {
  const apiKey = str(ctxGet(ctx, [`${name}_api_key`]))
  const block = ctxGet(ctx, ['provider', name])
  const fromBlock = (k: string): string | undefined => (block && typeof block === 'object' && 'get' in block ? str(ctxGet(block, [k])) : undefined)
  const key = apiKey ?? fromBlock('api_key') ?? fromBlock('api-key')
  const base = fromBlock('base_url') ?? fromBlock('base-url')
  const out: VoiceProvider = { ...(key ? { apiKey: key } : {}), ...(base ? { baseUrl: base } : {}) }
  for (const k of ['project', 'location', 'gcloud'] as const) {
    const v = fromBlock(k)
    if (v) out[k] = v
  }
  const engine = fromBlock('engine') ?? (fromBlock('type') === 'vertex' ? 'vertex' : undefined)
  if (engine) out.engine = engine
  return out
}

/** Vertex — явный `$engine: vertex` или проект у провайдера. */
export const isVertex = (p: VoiceProvider): boolean => (p.engine ? p.engine === 'vertex' : !!p.project)

/** Где gcloud, если `$gcloud` не задан: PATH и каталог SDK из Homebrew (у MCP-шелла его в PATH нет). */
const GCLOUD_DIRS = ['/opt/homebrew/share/google-cloud-sdk/bin']

/** Токен ADC: `gcloud auth application-default print-access-token` (кэш — у движка). */
export function gcloudToken(gcloud = 'gcloud'): () => Promise<string> {
  const PATH = [process.env.PATH ?? '', ...GCLOUD_DIRS].filter(Boolean).join(delimiter)
  return () =>
    new Promise((resolve, reject) => {
      execFile(gcloud, ['auth', 'application-default', 'print-access-token'], { env: { ...process.env, PATH }, timeout: 30_000, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(gcloud) }, (err, stdout, stderr) => {
        if (err) reject(new Error(`voice: токен Vertex не получен (${gcloud} auth application-default print-access-token): ${String(stderr || err.message).trim().split('\n')[0]}`))
        else resolve(stdout.trim())
      })
    })
}

export interface EngineFromCtxOpts {
  /** Имя провайдера; нет — `$voice_provider`, затем `vertex` (если с проектом), затем `google`. */
  provider?: string | undefined
  model?: string | undefined
  defaultVoice?: string | undefined
  /** Кэш дизайнов Gemini; у Vertex своих голосов нет. */
  cache: VoiceCache
  fetch?: typeof fetch | undefined
  /** Подмена токена Vertex (тесты). */
  token?: (() => Promise<string>) | undefined
  retries?: number | undefined
  maxRetryWait?: number | undefined
}

/** Имя провайдера озвучки по умолчанию: Vertex, если он настроен, иначе AI Studio. */
export function defaultVoiceProvider(ctx: unknown): string {
  return str(ctxGet(ctx, ['voice_provider'])) ?? (isVertex(providerOf(ctx, 'vertex')) ? 'vertex' : 'google')
}

/** Движок по конфигу runz — общий для сервиса, CLI-смока и пайплайнов (audiobook). */
export function engineFromCtx(ctx: unknown, o: EngineFromCtxOpts): TtsEngine {
  // Без явного провайдера и при обоих настроенных — маршрут по голосу (voice_… → AI Studio, студийные → Vertex).
  if (!o.provider && !str(ctxGet(ctx, ['voice_provider']))) {
    const v = providerOf(ctx, 'vertex')
    const g = providerOf(ctx, 'google')
    if (isVertex(v) && v.project && g.apiKey && !isVertex(g)) {
      return createRoutedEngine(engineFromCtx(ctx, { ...o, provider: 'google', defaultVoice: undefined, model: undefined }), engineFromCtx(ctx, { ...o, provider: 'vertex' }))
    }
  }
  const name = o.provider ?? defaultVoiceProvider(ctx)
  const cfg = providerOf(ctx, name)
  const common = {
    ...(o.model ? { model: o.model } : {}),
    ...(o.defaultVoice ? { defaultVoice: o.defaultVoice } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.retries !== undefined ? { retries: o.retries } : {}),
    ...(o.maxRetryWait !== undefined ? { maxRetryWait: o.maxRetryWait } : {}),
  }
  if (isVertex(cfg)) {
    if (!cfg.project) throw new Error(`voice: у провайдера ${name} нет $project (## $provider ${name} ~/.runz/config.md)`)
    return createVertexEngine({ project: cfg.project, ...(cfg.location ? { location: cfg.location } : {}), token: o.token ?? gcloudToken(cfg.gcloud), ...common })
  }
  if (!cfg.apiKey) throw new Error(`voice: нет ключа провайдера ${name} ($api_key в ## $provider ${name} ~/.runz/config.md)`)
  return createGeminiEngine({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}), cache: o.cache, ...common })
}

/** Кэш на json-файле: читается на каждый get (рестарт-прозрачность), пишется атомарно. */
export function fileCache(file: string, dir: string): VoiceCache {
  const load = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  return {
    get: (key) => load()[key],
    set(key, id) {
      const data = { ...load(), [key]: id }
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 1))
      renameSync(tmp, file)
    },
  }
}


// --- speak: все движки по конфигу ---

/** Настройка speak: атрибут блока `## $speak` (`$key`) или корневой `$speak_key`. */
export function speakOpt(ctx: unknown, name: string): unknown {
  // Путём, не через блок: `ctx.get(['speak'])` у runz отдаёт тело блока, а не объект атрибутов.
  const v = ctxGet(ctx, ['speak', name])
  return v === '' ? undefined : (v ?? ctxGet(ctx, [`speak_${name}`]))
}

/** Список из конфига: `$[a, b]` (IArray runz), JS-массив или строка `a, b`. */
export function listOf(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'object' && v && 'iterate' in v && typeof (v as { iterate: unknown }).iterate === 'function') return [...(v as { iterate(): Iterable<unknown> }).iterate()].map(String)
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

export interface EnginesFromCtxOpts {
  /** Кэш дизайнов AI Studio (свои голоса). */
  cache: VoiceCache
  fetch?: typeof fetch | undefined
  /** Подмена токена Google (тесты). */
  token?: (() => Promise<string>) | undefined
  /** Подмена клиента Edge (тесты). */
  edge?: EdgeClient | undefined
  /** Кэш библиотеки готовых голосов AI Studio (`fileLibraryCache`). */
  libraryCache?: LibraryCache | undefined
}

/**
 * Все движки speak по конфигу: `vertex` (`## $provider vertex` с `$project`), `studio`
 * (`## $provider google` с ключом — свои голоса и аудиокниги, только явно), `chirp` (тот же
 * проект и токен, что у Vertex), `edge` (без настройки), `openai` (`$openai_provider` блока
 * `## $speak` → `## $provider <имя>`: `$base_url`, `$api_key`, `$model` или `$openai_model` блока). `$engines` блока —
 * явный список включённых.
 */
export function enginesFromCtx(ctx: unknown, o: EnginesFromCtxOpts): Engines {
  const only = listOf(speakOpt(ctx, 'engines'))
  const on = (n: EngineName): boolean => !only || only.includes(n)
  const out: Engines = {}
  const v = providerOf(ctx, str(speakOpt(ctx, 'vertex_provider')) ?? 'vertex')
  const token = isVertex(v) && v.project ? (o.token ?? gcloudToken(v.gcloud)) : undefined
  const common = { ...(o.fetch ? { fetch: o.fetch } : {}) }
  if (on('vertex') && token && v.project) {
    const model = str(speakOpt(ctx, 'vertex_model'))
    out.vertex = createVertexEngine({ project: v.project, ...(v.location ? { location: v.location } : {}), token, ...(model ? { model } : {}), ...common })
  }
  const g = providerOf(ctx, str(speakOpt(ctx, 'studio_provider')) ?? 'google')
  if (on('studio') && g.apiKey && !isVertex(g)) {
    const model = str(speakOpt(ctx, 'studio_model'))
    out.studio = createGeminiEngine({ apiKey: g.apiKey, ...(g.baseUrl ? { baseUrl: g.baseUrl } : {}), cache: o.cache, ...(model ? { model } : {}), ...(o.libraryCache ? { libraryCache: o.libraryCache } : {}), ...common })
  }
  if (on('chirp') && token && v.project) out.chirp = createChirpEngine({ project: v.project, token, ...common })
  if (on('edge')) out.edge = createEdgeEngine(o.edge ? { client: o.edge } : {})
  const oname = str(speakOpt(ctx, 'openai_provider'))
  if (on('openai') && oname) {
    const p = providerOf(ctx, oname)
    // `$openai_model` блока `## $speak` — алиас речи у провайдера без своего `$model` (llm-gate).
    const model = str(speakOpt(ctx, 'openai_model')) ?? str(ctxGet(ctx, ['provider', oname, 'model']))
    if (!p.baseUrl || !model) throw new Error(`speak: у провайдера ${oname} нужны $base_url и $model (или $openai_model в ## $speak) (## $provider ${oname} ~/.runz/config.md)`)
    const voices = listOf(speakOpt(ctx, 'openai_voices'))
    out.openai = createOpenAIEngine({ baseUrl: p.baseUrl, model, ...(p.apiKey ? { apiKey: p.apiKey } : {}), ...(voices ? { voices, defaultVoice: voices[0] } : {}), ...common })
  }
  // Локальный без сети (DEV-513): macOS `say`; `$say_voice` — голос по умолчанию.
  if (on('say') && hasSay()) {
    const sv = str(speakOpt(ctx, 'say_voice'))
    out.say = createSayEngine(sv ? { defaultVoice: sv } : {})
  }
  return out
}
