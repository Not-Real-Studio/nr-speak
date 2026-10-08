/**
 * Кэш кусков на диске: `<dir>/<ключ[0..2]>/<ключ>.<формат>`. Запись атомарная
 * (временный файл + rename) — оборванный синтез не оставляет битый файл.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SegmentCache } from '../speaker.js'

export function diskCache(dir: string): SegmentCache {
  const path = (key: string): string => join(dir, key.slice(0, 2), key)
  return {
    async get(key) {
      try {
        const data = await readFile(path(key))
        return data.length ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined
      } catch {
        return undefined
      }
    },
    async set(key, data) {
      const file = path(key)
      await mkdir(join(dir, key.slice(0, 2)), { recursive: true })
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, data)
      await rename(tmp, file)
    },
  }
}
