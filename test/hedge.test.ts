import { describe, expect, it } from 'vitest'
import { hedged } from '../src/index.js'

const later = <T>(ms: number, v: T, signal: AbortSignal, fail = false): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => (fail ? reject(new Error(String(v))) : resolve(v)), ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })

describe('hedged (DEV-419)', () => {
  it('быстрый первый — без второго запуска', async () => {
    let runs = 0
    const events: string[] = []
    const v = await hedged((s) => (runs++, later(5, 'a', s)), 50, undefined, (w) => events.push(w))
    expect([v, runs, events]).toEqual(['a', 1, []])
  })

  it('завис первый — второй выигрывает, первый отменён', async () => {
    const aborted: number[] = []
    const events: string[] = []
    let n = 0
    const v = await hedged(
      (s) => {
        const me = n++
        s.addEventListener('abort', () => aborted.push(me))
        return later(me === 0 ? 1000 : 5, me === 0 ? 'slow' : 'fast', s)
      },
      20,
      undefined,
      (w) => events.push(w),
    )
    expect([v, aborted, events]).toEqual(['fast', [0], ['hedge']])
  })

  it('первый упал до хеджа — ошибка сразу', async () => {
    let runs = 0
    await expect(hedged((s) => (runs++, later(5, 'boom', s, true)), 50)).rejects.toThrow('boom')
    await new Promise((r) => setTimeout(r, 70))
    expect(runs).toBe(1)
  })

  it('упали оба — ошибка первого', async () => {
    const events: string[] = []
    let n = 0
    await expect(hedged((s) => later(n++ === 0 ? 40 : 5, n === 1 ? 'e1' : 'e2', s, true), 20, undefined, (w) => events.push(w))).rejects.toThrow()
    expect(events).toEqual(['none'])
  })

  it('0 — без хеджа', async () => {
    let runs = 0
    expect(await hedged((s) => (runs++, later(30, 'x', s)), 0)).toBe('x')
    expect(runs).toBe(1)
  })
})
