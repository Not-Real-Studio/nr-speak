/**
 * Запуск ffmpeg: байты на stdin → байты stdout. Где ffmpeg — `bin`, иначе PATH плюс
 * каталог Homebrew (у launchd и MCP-шелла его в PATH может не быть).
 */

import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'
import type { FfmpegRun } from '../audio.js'

const BREW = ['/opt/homebrew/bin', '/usr/local/bin']

export function ffmpegRunner(bin = 'ffmpeg'): FfmpegRun {
  const PATH = [process.env.PATH ?? '', ...BREW].filter(Boolean).join(delimiter)
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
