/**
 * Гонка куска (DEV-577): основной голос и параллельный (Pocket) стартуют вместе. Основной живёт
 * сам по себе — `startPrimary`: кадры копятся в буфере, по концу звук ложится в кэш, даже если
 * кусок сыграл параллельный. `pickFirst` решает, кто играет: первый звук основного за порог —
 * основной, иначе параллельный; основной упал — параллельный сразу.
 */

import type { AudioChunk } from './types.js'

export interface PrimaryRun<T> {
  /** Первый кадр основного; отказ — основной упал до звука. */
  readonly first: Promise<AudioChunk>
  /** Мс от старта до первого кадра (пока нет — `undefined`). */
  firstMs(): number | undefined
  /** Основной уже упал: новая гонка запускает его заново. */
  failed(): boolean
  /** Все кадры: накопленные, затем по мере прихода. Читателей может быть сколько угодно. */
  frames(): AsyncGenerator<AudioChunk>
  /** Звук дописан и обработан (`finish`). */
  readonly done: Promise<T>
}

export function startPrimary<T>(open: (signal: AbortSignal) => AsyncIterable<AudioChunk>, finish: (frames: readonly AudioChunk[]) => Promise<T>, timeoutMs: number, now: () => number = Date.now): PrimaryRun<T> {
  const t0 = now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error(`speak: основной голос не закончил за ${timeoutMs} мс`)), timeoutMs)
  timer.unref?.()
  const got: AudioChunk[] = []
  let firstMs: number | undefined
  let ended = false
  let error: { err: unknown } | undefined
  let wake = (): void => {}
  let tick = new Promise<void>((r) => (wake = r))
  const notify = (): void => {
    const w = wake
    tick = new Promise<void>((r) => (wake = r))
    w()
  }
  let onFirst: (c: AudioChunk) => void = () => {}
  let onFail: (e: unknown) => void = () => {}
  const first = new Promise<AudioChunk>((res, rej) => ((onFirst = res), (onFail = rej)))
  first.catch(() => {})
  const pump = (async () => {
    try {
      for await (const c of open(ctl.signal)) {
        got.push(c)
        if (got.length === 1) {
          firstMs = now() - t0
          onFirst(c)
        }
        notify()
      }
      if (!got.length) throw new Error('speak: провайдер не прислал звука')
    } catch (err) {
      error = { err }
      onFail(err)
      throw err
    } finally {
      clearTimeout(timer)
      ended = true
      notify()
    }
  })()
  const done = pump.then(() => finish(got))
  done.catch(() => {})
  return {
    first,
    firstMs: () => firstMs,
    failed: () => !!error,
    async *frames() {
      for (let i = 0; ; ) {
        const seen = tick
        while (i < got.length) yield got[i++]!
        if (error) throw error.err
        if (ended) return
        await seen
      }
    },
    done,
  }
}

export interface Pick {
  winner: 'primary' | 'parallel'
  first: AudioChunk
  /** Кадры победителя начиная с первого. */
  frames: AsyncIterable<AudioChunk>
  /** Почему играет параллельный: порог или ошибка основного. */
  reason?: string
  /** Первый звук параллельного от старта гонки; нет — не дождались. */
  parallelMs?: number
}

/**
 * Кто играет кусок. `parallel` стартует сразу, если основной ещё молчит; порог `ms` — от этого
 * момента (момента, когда кусок нужен для игры). Порог прошёл, а параллельный ещё молчит —
 * играет тот, кто заговорит первым. Оба упали — ошибка основного.
 */
export function pickFirst<T>(run: PrimaryRun<T>, parallel: (signal: AbortSignal) => AsyncIterable<AudioChunk>, ms: number, signal?: AbortSignal, now: () => number = Date.now): Promise<Pick> {
  if (run.firstMs() !== undefined) return run.first.then((first) => ({ winner: 'primary' as const, first, frames: run.frames() }))
  const t0 = now()
  const ctl = new AbortController()
  const it = parallel(ctl.signal)[Symbol.asyncIterator]()
  return new Promise<Pick>((resolve, reject) => {
    let settled = false
    let late = false
    let spare: { c: AudioChunk; ms: number } | undefined
    let spareDead = false
    let dead: { err: unknown } | undefined
    const stop = (): void => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const dropSpare = (): void => {
      ctl.abort()
      void it.return?.(undefined)?.catch?.(() => {})
    }
    const onAbort = (): void => {
      if (settled) return
      stop()
      dropSpare()
      reject(new Error('speak: синтез отменён'))
    }
    const takeSpare = (reason: string): void => {
      const s = spare!
      stop()
      signal?.addEventListener('abort', () => ctl.abort(), { once: true })
      resolve({ winner: 'parallel', first: s.c, frames: rest(s.c, it), reason, parallelMs: s.ms })
    }
    const timer = setTimeout(() => {
      late = true
      if (!settled && spare) takeSpare(`нет звука за ${ms} мс`)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    run.first.then(
      (first) => {
        if (settled) return
        stop()
        dropSpare()
        resolve({ winner: 'primary', first, frames: run.frames(), ...(spare ? { parallelMs: spare.ms } : {}) })
      },
      (err: unknown) => {
        dead = { err }
        if (settled) return
        if (spare) takeSpare(String((err as Error)?.message ?? err))
        else if (spareDead) {
          stop()
          reject(err)
        }
      },
    )
    it.next().then(
      (n) => {
        if (n.done) throw new Error('speak: параллельный голос не прислал звука')
        spare = { c: n.value, ms: now() - t0 }
        if (settled) return
        if (dead) takeSpare(String((dead.err as Error)?.message ?? dead.err))
        else if (late) takeSpare(`нет звука за ${ms} мс`)
      },
    ).catch((err: unknown) => {
      spareDead = true
      if (settled || !dead) return
      stop()
      reject(dead.err)
      void err
    })
  })
}

async function* rest(first: AudioChunk, it: AsyncIterator<AudioChunk>): AsyncGenerator<AudioChunk> {
  try {
    yield first
    for (let n = await it.next(); !n.done; n = await it.next()) yield n.value
  } finally {
    await it.return?.(undefined)?.catch?.(() => {})
  }
}
