/**
 * Запуск ffmpeg: байты на stdin → байты stdout. Где ffmpeg — `bin`, иначе PATH плюс
 * каталог Homebrew (у launchd и MCP-шелла его в PATH может не быть).
 */

import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'
import type { FfmpegPipe, FfmpegRun } from '../audio.js'

const BREW = ['/opt/homebrew/bin', '/usr/local/bin']
const pathEnv = (): string => [process.env.PATH ?? '', ...BREW].filter(Boolean).join(delimiter)

export function ffmpegRunner(bin = 'ffmpeg'): FfmpegRun {
  const PATH = pathEnv()
  return (args, input) =>
    new Promise((resolve, reject) => {
      const p = spawn(bin, args, { env: { ...process.env, PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      p.stdout.on('data', (b: Buffer) => out.push(b))
      p.stderr.on('data', (b: Buffer) => err.push(b))
      p.on('error', (e) => reject(new Error(`speak: ffmpeg не запустился (${bin}): ${e.message}`)))
      p.on('close', (code) => {
        if (code === 0) resolve(new Uint8Array(Buffer.concat(out)))
        else reject(new Error(`speak: ffmpeg вышел с кодом ${code}: ${Buffer.concat(err).toString().trim().split('\n').slice(-2).join(' ')}`))
      })
      p.stdin.on('error', () => {}) // EPIPE при падении ffmpeg — ошибка придёт кодом выхода
      p.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength))
    })
}

/**
 * ffmpeg трубой (поток первого звука): stdin пишется с учётом backpressure, stdout отдаётся
 * кусками по мере кодирования. Выход с ошибкой — исключение из `output` после последнего куска.
 */
export function ffmpegPipe(bin = 'ffmpeg'): FfmpegPipe {
  const PATH = pathEnv()
  return (args) => {
    const p = spawn(bin, args, { env: { ...process.env, PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
    const err: Buffer[] = []
    let killed = false
    let spawnError: Error | undefined
    p.stderr.on('data', (b: Buffer) => err.push(b))
    p.stdin.on('error', () => {}) // EPIPE — ошибка придёт кодом выхода
    const closed = new Promise<number | null>((resolve) => {
      p.on('error', (e) => {
        spawnError = new Error(`speak: ffmpeg не запустился (${bin}): ${e.message}`)
        resolve(null)
      })
      p.on('close', (code) => resolve(code))
    })
    async function* output(): AsyncGenerator<Uint8Array> {
      for await (const b of p.stdout) yield new Uint8Array((b as Buffer).buffer, (b as Buffer).byteOffset, (b as Buffer).byteLength)
      const code = await closed
      if (spawnError) throw spawnError
      if (code !== 0 && !killed) throw new Error(`speak: ffmpeg вышел с кодом ${code}: ${Buffer.concat(err).toString().trim().split('\n').slice(-2).join(' ')}`)
    }
    return {
      write: (data) =>
        new Promise<void>((resolve) => {
          if (p.stdin.destroyed || !p.stdin.writable) return resolve()
          if (p.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) resolve()
          else {
            const done = (): void => {
              p.stdin.off('drain', done)
              p.stdin.off('close', done)
              resolve()
            }
            p.stdin.once('drain', done)
            p.stdin.once('close', done)
          }
        }),
      end: () => void p.stdin.end(),
      output: output(),
      kill: () => {
        killed = true
        p.kill('SIGKILL')
      },
    }
  }
}
