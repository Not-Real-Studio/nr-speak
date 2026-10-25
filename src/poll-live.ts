/**
 * Псевдопоток (25.10): «живое» распознавание любым OpenAI-совместимым `/audio/transcriptions`
 * без потокового API — GigaAM на m4 распознаёт 5 с звука за ~0,15 с, так что хвост записи
 * распознаётся заново раз в `intervalMs`, а текст отдаётся `onPartial`. Тот же контракт, что у
 * `openLiveTranscription` (`LiveTranscription`): поток speak, сбор и фолбэки не меняются.
 *
 * Длинная запись не гоняется целиком: хвост длиннее `commitSec` режется в самом тихом окне
 * последней трети (как в замере DEV-420) — голова распознаётся один раз и закрепляется, дальше
 * растёт только хвост. Запросы — по одному на запись (новый — после ответа на прошлый).
 */

import { pcmToWav, type LiveRate, type LiveTranscription } from './live.js'

export interface PollLiveOpts {
  /** Корень OpenAI-совместимого API (`http://host:8084/v1`). */
  baseUrl: string
  apiKey?: string | undefined
  model: string
  rate?: LiveRate | undefined
  language?: string | undefined
  /** Пауза между запросами, мс (по умолчанию 500). */
  intervalMs?: number | undefined
  /** Хвост длиннее — голова закрепляется, с (по умолчанию 20). */
  commitSec?: number | undefined
  onPartial?: ((text: string) => void) | undefined
  fetch?: typeof fetch | undefined
}

/** Самое тихое окно 0,2 с в последней трети `[0, n)` сэмплов PCM16 — точка реза. */
export function quietCut(pcm: Uint8Array, rate: number, n: number): number {
  const v = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1)
  const win = Math.round(rate * 0.2)
  let best = Infinity
  let cut = n
  for (let s = Math.floor((n * 2) / 3); s + win <= n; s += win >> 1) {
    let e = 0
    for (let i = s; i < s + win; i++) e += v[i]! * v[i]!
    if (e < best) {
      best = e
      cut = s + (win >> 1)
    }
  }
  return cut
}

export function openPollTranscription(o: PollLiveOpts): LiveTranscription {
  const rate = o.rate ?? 16000
  const interval = o.intervalMs ?? 500
  const commitSamples = Math.round((o.commitSec ?? 20) * rate)
  const doFetch = o.fetch ?? fetch
  const url = `${o.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`
  const chunks: Uint8Array[] = []
  let bytes = 0
  /** Байт PCM, закреплённых текстом `committed`. */
  let from = 0
  let committed = ''
  let tail = ''
  /** Сколько байт было в последнем отправленном хвосте (не слать то же самое). */
  let sentUpTo = -1
  let busy: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let ended = false
  let failure: Error | null = null

  const join = (a: string, b: string): string => [a, b].filter((x) => x.trim()).join(' ').trim()
  const text = (): string => join(committed, tail)

  function slice(a: number, b: number): Uint8Array {
    const out = new Uint8Array(b - a)
    let pos = 0
    let off = 0
    for (const c of chunks) {
      const end = pos + c.byteLength
      if (end > a && pos < b) {
        const s = Math.max(a, pos) - pos
        const e = Math.min(b, end) - pos
        out.set(c.subarray(s, e), off)
        off += e - s
      }
      pos = end
      if (pos >= b) break
    }
    return out
  }

  async function recognize(pcm: Uint8Array): Promise<string> {
    if (pcm.byteLength < rate * 2 * 0.3) return ''
    const form = new FormData()
    form.append('file', new Blob([pcmToWav(pcm, rate) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'audio.wav')
    form.append('model', o.model)
    form.append('response_format', 'json')
    if (o.language) form.append('language', o.language)
    const r = await doFetch(url, { method: 'POST', body: form, headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {} })
    if (!r.ok) throw new Error(`listen poll: ${o.model} HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`)
    const j = (await r.json()) as { text?: unknown }
    return typeof j.text === 'string' ? j.text.trim() : ''
  }

  /** Один проход: закрепить голову, если хвост длинный; распознать хвост. */
  async function step(final: boolean): Promise<void> {
    let end = bytes
    while ((end - from) >> 1 > commitSamples) {
      const head = slice(from, end)
      const cut = from + quietCut(head, rate, commitSamples) * 2
      committed = join(committed, await recognize(slice(from, cut)))
      from = cut
      tail = ''
      end = bytes
    }
    if (!final && end === sentUpTo) return
    sentUpTo = end
    const t = await recognize(slice(from, end))
    if (closed) return
    tail = t
    o.onPartial?.(text())
  }

  function schedule(): void {
    if (timer || closed || ended) return
    timer = setTimeout(() => {
      timer = null
      if (closed || ended || busy) return
      busy = step(false)
        .catch((err: Error) => {
          failure = err
        })
        .finally(() => {
          busy = null
          schedule()
        })
    }, interval)
  }

  return {
    ready: Promise.resolve(),
    get sessions() {
      return 1
    },
    push(pcm: Uint8Array): void {
      if (closed || ended || !pcm.byteLength) return
      chunks.push(pcm.slice())
      bytes += pcm.byteLength
      schedule()
    },
    async end(): Promise<string> {
      ended = true
      if (timer) clearTimeout(timer)
      timer = null
      await busy
      await step(true)
      if (failure && !text()) throw failure
      return text()
    },
    close(): void {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    text,
  }
}
