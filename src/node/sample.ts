/**
 * Образцы клона локальных движков (DEV-520) с диска: путь к звуку (`~` — домашний), текст
 * образца — соседний `.txt` (`denis-11s.wav` → `denis-11s.txt`) или `<путь>.txt`. Не WAV —
 * в WAV 24 кГц моно через ffmpeg (если передан). Читается на каждый вызов: движок сам помнит,
 * что образец уже на сервере (по хэшу).
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FfmpegRun } from '../audio.js'
import type { LocalSample } from '../local.js'

export const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

export function fileSampleLoader(o: { ffmpeg?: FfmpegRun | undefined } = {}): (ref: string) => Promise<LocalSample> {
  return async (ref) => {
    const file = expandHome(ref.trim())
    if (!existsSync(file)) throw new Error(`speak: образца нет: ${ref}`)
    let audio: Uint8Array = readFileSync(file)
    if (!/\.wav$/i.test(file)) {
      if (!o.ffmpeg) throw new Error(`speak: образец «${ref}» не WAV, а ffmpeg не подключён`)
      audio = await o.ffmpeg(['-i', 'pipe:0', '-ar', '24000', '-ac', '1', '-sample_fmt', 's16', '-f', 'wav', 'pipe:1'], audio)
    }
    const txt = [file.replace(/\.[^./\\]+$/, '.txt'), `${file}.txt`].find((f) => existsSync(f))
    const text = txt ? readFileSync(txt, 'utf8').trim() : undefined
    return { audio, ...(text ? { text } : {}) }
  }
}
