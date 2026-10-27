/**
 * Аудио-выход без Node: склейка кадров, WAV-заголовок, решение «перекодировать или
 * отдать как есть» и аргументы ffmpeg. Сам ffmpeg — инъекцией `FfmpegRun`
 * (`@notrealstudio/speak/node` даёт `ffmpegRunner`). mp3 от Edge/Chirp/OpenAI в mp3 —
 * без перекодирования; PCM ↔ wav/pcm — заголовком в JS.
 */

import type { AudioChunk } from './types.js'
import { isMp3, isPcm, isWav, rateOf } from './types.js'

export const FORMATS = ['mp3', 'wav', 'opus', 'pcm'] as const
export type Format = (typeof FORMATS)[number]
export const isFormat = (s: string): s is Format => (FORMATS as readonly string[]).includes(s)

export const CONTENT_TYPE: Record<Format, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', pcm: 'audio/pcm' }
/** Частота PCM на выходе (как у Gemini и OpenAI `pcm`). */
export const OUT_RATE = 24000

/** Запуск ffmpeg: аргументы, байты на stdin → байты stdout. */
export type FfmpegRun = (args: string[], input: Uint8Array) => Promise<Uint8Array>

/**
 * ffmpeg трубой: байты пишутся по мере прихода, выход читается по мере кодирования
 * (поток первого звука). `output` бросает, если ffmpeg вышел с ошибкой; `kill` — оборвать.
 */
export interface FfmpegProc {
  write(data: Uint8Array): Promise<void>
  end(): void
  output: AsyncIterable<Uint8Array>
  kill(): void
}
export type FfmpegPipe = (args: string[]) => FfmpegProc

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Кадры одного синтеза → одно аудио (mime — первого кадра). */
export async function collect(chunks: AsyncIterable<AudioChunk>): Promise<AudioChunk> {
  const parts: Uint8Array[] = []
  let mime = ''
  let fallback: string | undefined
  for await (const c of chunks) {
    mime ||= c.mime
    fallback ??= c.fallback
    parts.push(c.data)
  }
  if (!parts.length) throw new Error('speak: провайдер не прислал звука')
  return { data: concat(parts), mime, ...(fallback ? { fallback } : {}) }
}

/**
 * WAV-заголовок s16le моно. `bytes` не задан — «стримовый» заголовок с размером
 * 0xFFFFFFFF: длина заранее неизвестна, плееры читают до конца потока.
 */
export function wavHeader(rate: number, bytes?: number): Uint8Array {
  const h = new Uint8Array(44)
  const v = new DataView(h.buffer)
  const str = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i)
  }
  const size = bytes ?? 0xffffffff - 36
  str(0, 'RIFF')
  v.setUint32(4, Math.min(36 + size, 0xffffffff), true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, size, true)
  return h
}

/** WAV → `{pcm, rate}` (ищет чанк `data`, не полагаясь на 44 байта). */
export function parseWav(data: Uint8Array): { pcm: Uint8Array; rate: number } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const tag = (at: number): string => String.fromCharCode(...data.subarray(at, at + 4))
  if (data.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { pcm: data, rate: OUT_RATE }
  let rate = OUT_RATE
  for (let at = 12; at + 8 <= data.length; ) {
    const id = tag(at)
    const len = v.getUint32(at + 4, true)
    if (id === 'fmt ') rate = v.getUint32(at + 12, true)
    if (id === 'data') return { pcm: data.subarray(at + 8, Math.min(data.length, at + 8 + len)), rate }
    at += 8 + len + (len % 2)
  }
  return { pcm: data.subarray(44), rate }
}

/** Цепочка atempo: один фильтр держит 0.5…2, дальше — произведением. */
export function atempo(speed: number): string {
  const parts: number[] = []
  let s = speed
  while (s > 2) {
    parts.push(2)
    s /= 2
  }
  while (s < 0.5) {
    parts.push(0.5)
    s /= 0.5
  }
  parts.push(Math.round(s * 1000) / 1000)
  return parts.map((p) => `atempo=${p}`).join(',')
}

/** Аргументы ffmpeg: вход по mime, темп, выход по формату (wav — как pcm, заголовок ставит JS); `live` — для трубы. */
export function ffmpegArgs(mime: string, to: Format, speed = 1, live = false): string[] {
  const input = isMp3(mime) ? ['-f', 'mp3'] : isWav(mime) ? ['-f', 'wav'] : ['-f', 's16le', '-ar', String(rateOf(mime)), '-ac', '1']
  const filter = speed !== 1 ? ['-filter:a', atempo(speed)] : []
  const output =
    to === 'mp3'
      ? ['-c:a', 'libmp3lame', '-b:a', '64k', '-ar', String(OUT_RATE), '-ac', '1', '-f', 'mp3']
      : to === 'opus'
        ? ['-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-f', 'ogg']
        : ['-f', 's16le', '-ar', String(OUT_RATE), '-ac', '1']
  // live — труба: кадры наружу сразу, без буфера муксера (первый звук раньше).
  const flush = live ? ['-flush_packets', '1'] : []
  return ['-hide_banner', '-loglevel', 'error', ...input, '-i', 'pipe:0', ...filter, ...output, ...flush, 'pipe:1']
}

/**
 * Аудио движка → нужный формат. Без перекодирования: mp3 → mp3, PCM/wav → pcm/wav
 * (при родной частоте и темпе 1). Остальное — ffmpeg. `pcm`-выход — всегда 24 кГц.
 */
export async function convert(audio: AudioChunk, to: Format, o: { speed?: number | undefined; ffmpeg?: FfmpegRun | undefined } = {}): Promise<Uint8Array> {
  const speed = o.speed && o.speed !== 1 ? o.speed : 1
  if (speed === 1) {
    if (to === 'mp3' && isMp3(audio.mime)) return audio.data
    if ((to === 'pcm' || to === 'wav') && (isPcm(audio.mime) || isWav(audio.mime))) {
      const { pcm, rate } = isWav(audio.mime) ? parseWav(audio.data) : { pcm: audio.data, rate: rateOf(audio.mime) }
      if (rate === OUT_RATE) return to === 'pcm' ? pcm : concat([wavHeader(rate, pcm.length), pcm])
    }
  }
  if (!o.ffmpeg) throw new Error(`speak: нужен ffmpeg, чтобы перевести ${audio.mime} в ${to}${speed !== 1 ? ` с темпом ${speed}` : ''}`)
  const out = await o.ffmpeg(ffmpegArgs(audio.mime, to, speed), audio.data)
  return to === 'wav' ? concat([wavHeader(OUT_RATE, out.length), out]) : out
}

/** Стримовый WAV (размеры 0xFFFFFFFF) → файл с честными размерами. */
export function finalizeWav(data: Uint8Array): Uint8Array {
  if (data.length < 44) return data
  const out = data.slice()
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength)
  v.setUint32(4, out.length - 8, true)
  v.setUint32(40, out.length - 44, true)
  return out
}
