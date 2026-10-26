import { describe, expect, it } from 'vitest'
import { enginesFromCtx, listOf, speakOpt } from '../src/node/index.js'
import { fakeCtx } from './helpers.js'

const cache = { get: () => undefined, set: () => {} }
const token = async (): Promise<string> => 't'

describe('enginesFromCtx', () => {
  it('vertex + studio + chirp + edge по провайдерам; openai — только по $openai_provider', () => {
    const ctx = fakeCtx({
      provider: {
        vertex: { type: 'vertex', project: 'p1' },
        google: { type: 'openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', api_key: 'test-key-1' },
      },
    })
    const e = enginesFromCtx(ctx, { cache, token })
    expect(Object.keys(e).filter((k) => k !== 'say').sort()).toEqual(['chirp', 'edge', 'studio', 'vertex'])
    // Локальный `say` — только на macOS (DEV-513).
    expect('say' in e).toBe(process.platform === 'darwin')
    expect(e.vertex!.kind).toBe('vertex')
    expect(e.studio!.kind).toBe('gemini')
  })

  it('$engines в ## $speak — явный список; openai без $base_url/$model — ошибка', () => {
    const ctx = fakeCtx({
      speak: { engines: 'edge, openai', openai_provider: 'mlx' },
      provider: { vertex: { type: 'vertex', project: 'p1' }, mlx: { base_url: 'http://127.0.0.1:8000/v1', model: 'qwen3-tts' } },
    })
    expect(Object.keys(enginesFromCtx(ctx, { cache, token })).filter((k) => k !== 'say').sort()).toEqual(['edge', 'openai'])
    const bad = fakeCtx({ speak: { openai_provider: 'mlx' }, provider: { mlx: { base_url: 'http://h' } } })
    expect(() => enginesFromCtx(bad, { cache, token })).toThrow(/нужны \$base_url и \$model/)
  })

  it('openai: $openai_model блока ## $speak — модель у провайдера без $model (llm-gate)', async () => {
    const ctx = fakeCtx({ speak: { engines: 'openai', openai_provider: 'gate', openai_model: 'speech' }, provider: { gate: { base_url: 'https://g/v1', api_key: 'gk' } } })
    let body: Record<string, unknown> = {}
    const fetch = (async (_url: string, init: RequestInit = {}) => ((body = JSON.parse(String(init.body))), new Response(new Uint8Array([0xff, 0xfb, 0, 0])))) as typeof globalThis.fetch
    for await (const _ of enginesFromCtx(ctx, { cache, fetch }).openai!.speak('привет', 'alloy', {})) break
    expect(body.model).toBe('speech')
  })

  it('без провайдеров — только edge', () => {
    expect(Object.keys(enginesFromCtx(fakeCtx({}), { cache })).filter((k) => k !== 'say')).toEqual(['edge'])
  })

  it('speakOpt: блок ## $speak или корневой $speak_<имя>; listOf — массив, IArray, строка', () => {
    expect(speakOpt(fakeCtx({ speak: { key: 'k1' } }), 'key')).toBe('k1')
    expect(speakOpt(fakeCtx({ speak_key: 'k2' }), 'key')).toBe('k2')
    expect(listOf('a, b')).toEqual(['a', 'b'])
    expect(listOf({ iterate: () => ['x', 'y'][Symbol.iterator]() })).toEqual(['x', 'y'])
    expect(listOf(undefined)).toBeUndefined()
  })
})
