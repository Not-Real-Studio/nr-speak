/**
 * Клиент любого OpenAI-совместимого `POST /v1/audio/speech` (`base_url`, `api_key`,
 * `model`) — под локальный `mlx-audio` и подобные. Сам OpenAI TTS не используем
 * (выключают 06.01.2027). Ответ — тело целиком: `mp3` при `format: 'mp3'`, иначе `pcm`
 * (s16le 24 кГц, как у OpenAI).
 */

import type { AudioChunk, SpeakOpts, TtsEngine, VoiceInfo } from './types.js'
import { statusError } from './types.js'

export interface OpenAIOpts {
  /** Корень API с `/v1` или без (`http://127.0.0.1:8000/v1`). */
  baseUrl: string
  apiKey?: string | undefined
  model: string
  defaultVoice?: string | undefined
  /** Голоса для каталога: у протокола списка голосов нет. */
  voices?: readonly string[] | undefined
  fetch?: typeof fetch | undefined
}

/** `http://h:8000` / `http://h:8000/v1/` → `http://h:8000/v1`. */
export function openaiRoot(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, '')
  return /\/v\d+$/.test(u) ? u : `${u}/v1`
}

export function createOpenAIEngine(o: OpenAIOpts): TtsEngine {
  const http = o.fetch ?? fetch
  const root = openaiRoot(o.baseUrl)
  const list = o.voices ?? (o.defaultVoice ? [o.defaultVoice] : [])
  return {
    kind: 'openai',
    limit: 0,
    nativeSpeed: true,
    async voices(): Promise<VoiceInfo[]> {
      return list.map((id) => ({ id, type: 'prebuilt', name: id }))
    },
    async design() {
      throw new Error('openai.design: свои голоса через этот протокол не делаются')
    },
    async *speak(text: string, voiceId: string, opts: SpeakOpts, signal?: AbortSignal): AsyncGenerator<AudioChunk> {
      const voice = voiceId || o.defaultVoice
      if (!voice) throw new Error('openai.speak: не задан голос (voice или defaultVoice)')
      const mp3 = opts.format === 'mp3'
      const body: Record<string, unknown> = { model: o.model, input: text, voice, response_format: mp3 ? 'mp3' : 'pcm' }
      if (opts.speed && opts.speed !== 1) body.speed = opts.speed
      if (opts.instruct?.trim()) body.instructions = opts.instruct.trim()
      const res = await http(`${root}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw statusError(`openai.speak: HTTP ${res.status}${t ? ` — ${t.slice(0, 200)}` : ''}`, res.status)
      }
      // Звук — по мере прихода (llm-gate стримит синтез): первый кусок не ждёт конца фразы.
      // PCM 16 бит — куски по чётной границе, нечётный байт ждёт следующего.
      const mime = mp3 ? 'audio/mpeg' : 'audio/l16; rate=24000; channels=1'
      let total = 0
      let carry: Uint8Array | null = null
      const reader = res.body?.getReader()
      if (!reader) {
        const data = new Uint8Array(await res.arrayBuffer())
        if (!data.length) throw new Error('openai.speak: пустой ответ')
        yield { data, mime }
        return
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        let data: Uint8Array = carry ? concat(carry, value) : value
        carry = null
        if (!mp3 && data.length % 2) {
          carry = data.subarray(data.length - 1)
          data = data.subarray(0, data.length - 1)
        }
        if (!data.length) continue
        total += data.length
        yield { data, mime }
      }
      if (!total) throw new Error('openai.speak: пустой ответ')
    },
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
