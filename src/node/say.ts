/**
 * Локальный движок без сети (voice-everywhere-spec §2, DEV-513): macOS `say`. Голоса — системные
 * (`say -v '?'`: `Milena ru_RU`); звук — WAV s16 22 кГц из временного файла (в трубу `say` пишет
 * только AIFF). Темп — забота перекодировщика (`nativeSpeed` нет): `-r` у `say` — слова в минуту,
 * у разных голосов по-разному звучит.
 *
 * Выбор против Piper (26.10): `say` есть на любом маке без установки, русская Milena разборчива;
 * Piper лучше звучит, но ставится отдельно (бинарь + модель) — следующий кандидат, тот же контракт.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudioChunk, TtsEngine, VoiceInfo } from '../types.js'

export const SAY_DEFAULT_VOICE = 'Milena'

export interface SayEngineOpts {
  /** Путь к `say` (по умолчанию из PATH, `/usr/bin/say`). */
  bin?: string | undefined
  defaultVoice?: string | undefined
  /** Только эти языки в каталоге (`ru_RU`, `en_US`); нет — все. */
  langs?: readonly string[] | undefined
  /** Подмена запуска (тесты). */
  exec?: ((bin: string, args: string[], signal?: AbortSignal) => Promise<string>) | undefined
}

const run = (bin: string, args: string[], signal?: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120_000, maxBuffer: 4 << 20, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      if (err) reject(new Error(`say: ${String(stderr || err.message).trim().split('\n')[0]}`))
      else resolve(stdout)
    })
  })

/** Строка `say -v '?'`: `Milena              ru_RU    # Здравствуйте!` (имя бывает с пробелами и скобками). */
export function parseSayVoices(out: string): VoiceInfo[] {
  const list: VoiceInfo[] = []
  for (const line of out.split('\n')) {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(line)
    if (!m) continue
    list.push({ id: m[1]!.trim(), type: 'prebuilt', name: m[1]!.trim(), lang: m[2]!.replace('_', '-') })
  }
  return list
}

/** Доступен ли `say` (macOS). */
export const hasSay = (): boolean => process.platform === 'darwin'

export function createSayEngine(o: SayEngineOpts = {}): TtsEngine {
  const bin = o.bin ?? 'say'
  const exec = o.exec ?? run
  let catalog: Promise<VoiceInfo[]> | null = null
  return {
    kind: 'say',
    limit: 0,
    voices() {
      catalog ??= exec(bin, ['-v', '?']).then((out) => parseSayVoices(out).filter((v) => !o.langs?.length || o.langs.includes((v.lang ?? '').replace('-', '_'))))
      catalog.catch(() => {
        catalog = null
      })
      return catalog
    },
    async design() {
      throw new Error('say.design: у системного синтеза своих голосов нет')
    },
    async *speak(text, voiceId, _opts, signal): AsyncGenerator<AudioChunk> {
      const voice = voiceId || o.defaultVoice || SAY_DEFAULT_VOICE
      const dir = await mkdtemp(join(tmpdir(), 'nr-say-'))
      const file = join(dir, 'out.wav')
      try {
        await exec(bin, ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@22050', '-o', file, '--', text], signal)
        const data = new Uint8Array(await readFile(file))
        if (data.byteLength <= 44) throw new Error('say: пустой звук')
        yield { data, mime: 'audio/wav' }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
