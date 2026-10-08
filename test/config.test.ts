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
    expect(Object.keys(e).sort()).toEqual(['chirp', 'edge', 'studio', 'vertex'])
    expect(e.vertex!.kind).toBe('vertex')
    expect(e.studio!.kind).toBe('gemini')
  })

  it('$engines в ## $speak — явный список; openai без $base_url/$model — ошибка', () => {
    const ctx = fakeCtx({
      speak: { engines: 'edge, openai', openai_provider: 'mlx' },
      provider: { vertex: { type: 'vertex', project: 'p1' }, mlx: { base_url: 'http://127.0.0.1:8000/v1', model: 'qwen3-tts' } },
    })
    expect(Object.keys(enginesFromCtx(ctx, { cache, token })).sort()).toEqual(['edge', 'openai'])
    const bad = fakeCtx({ speak: { openai_provider: 'mlx' }, provider: { mlx: { base_url: 'http://h' } } })
    expect(() => enginesFromCtx(bad, { cache, token })).toThrow(/нужны \$base_url и \$model/)
  })

  it('без провайдеров — только edge', () => {
    expect(Object.keys(enginesFromCtx(fakeCtx({}), { cache }))).toEqual(['edge'])
  })

  it('speakOpt: блок ## $speak или корневой $speak_<имя>; listOf — массив, IArray, строка', () => {
    expect(speakOpt(fakeCtx({ speak: { key: 'k1' } }), 'key')).toBe('k1')
    expect(speakOpt(fakeCtx({ speak_key: 'k2' }), 'key')).toBe('k2')
    expect(listOf('a, b')).toEqual(['a', 'b'])
    expect(listOf({ iterate: () => ['x', 'y'][Symbol.iterator]() })).toEqual(['x', 'y'])
    expect(listOf(undefined)).toBeUndefined()
  })
})
