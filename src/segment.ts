/**
 * Сегменты: блоки нормализатора (или простой текст) → куски под один запрос синтеза.
 * Лимит Gemini — ~4000 байт на запрос (кириллица — 2 байта на букву), поэтому кусок
 * ограничен и символами, и байтами. Первый кусок короткий — ради быстрого старта звука;
 * заголовок — всегда отдельный кусок (пауза до и после). Резать — по абзацам, затем по
 * предложениям, затем по запятым и пробелам; слово не рвётся.
 */

export type BlockKind = 'heading' | 'para' | 'list' | 'table' | 'code' | 'quote'

export interface Block {
  kind: BlockKind
  text: string
}

export interface Segment {
  text: string
  /** `heading` — заголовок отдельным куском, остальное — `text`. */
  kind: 'heading' | 'text'
}

export interface SegmentOpts {
  /** Потолок куска, символов (по умолчанию 1500). */
  maxChars?: number | undefined
  /** Потолок куска, байт UTF-8 (по умолчанию 3600 — с запасом от 4000 у Gemini). */
  maxBytes?: number | undefined
  /** Цель первого куска, символов (по умолчанию 250): одно-два предложения. */
  first?: number | undefined
}

const enc = new TextEncoder()
export const bytes = (s: string): number => enc.encode(s).length

/** Предложения: граница — `.!?…` (и закрывающая кавычка/скобка) + пробел. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["»)\]]?)\s+/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Кусок длиннее потолка — по запятым/точкам с запятой/тире, затем по пробелам. */
function hardSplit(s: string, fits: (x: string) => boolean): string[] {
  if (fits(s)) return [s]
  for (const re of [/(?<=[,;:])\s+/u, /\s+(?=[—–])/u, /\s+/u]) {
    const parts = s.split(re)
    if (parts.length < 2) continue
    const out: string[] = []
    let cur = ''
    for (const p of parts) {
      const next = cur ? `${cur} ${p}` : p
      if (fits(next)) cur = next
      else {
        if (cur) out.push(cur)
        cur = p
      }
    }
    if (cur) out.push(cur)
    if (out.every(fits)) return out
    return out.flatMap((x) => hardSplit(x, fits))
  }
  // Одно «слово» длиннее потолка (хэш, ссылка) — режем по символам.
  const out: string[] = []
  let cur = ''
  for (const ch of s) {
    if (!fits(cur + ch)) {
      out.push(cur)
      cur = ''
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** Заголовок читается как фраза: без точки в конце модель тянет интонацию дальше. */
export const closeSentence = (s: string): string => (/[.!?…:;]["»)]?$/u.test(s) ? s : `${s}.`)

export function segment(blocks: readonly Block[], o: SegmentOpts = {}): Segment[] {
  const maxChars = o.maxChars ?? 1500
  const maxBytes = o.maxBytes ?? 3600
  const firstTarget = o.first ?? 250
  const out: Segment[] = []
  let cur = ''
  const limit = (): number => (out.length === 0 ? Math.min(firstTarget, maxChars) : maxChars)
  const fits = (s: string): boolean => s.length <= maxChars && bytes(s) <= maxBytes
  const flush = (): void => {
    if (cur.trim()) out.push({ text: cur.trim(), kind: 'text' })
    cur = ''
  }
  for (const b of blocks) {
    const text = b.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (b.kind === 'heading') {
      flush()
      for (const piece of hardSplit(closeSentence(text), fits)) out.push({ text: piece, kind: 'heading' })
      continue
    }
    // Абзац целиком влезает в текущий кусок — дописываем; иначе по предложениям.
    const joined = cur ? `${cur}\n\n${text}` : text
    if (joined.length <= limit() && fits(joined)) {
      cur = joined
      continue
    }
    if (cur && out.length > 0) flush()
    for (const s of sentences(text).flatMap((x) => hardSplit(x, fits))) {
      const next = cur ? `${cur} ${s}` : s
      if (cur && (next.length > limit() || !fits(next))) {
        flush()
        cur = s
      } else cur = next
      // Первый кусок набран — отдаём сразу, остальное — обычным размером.
      if (out.length === 0 && cur.length >= firstTarget) flush()
    }
  }
  flush()
  return out
}

/** Простой текст (API `/v1/audio/speech`): абзацы по пустой строке → сегменты. */
export function segmentText(text: string, o: SegmentOpts = {}): Segment[] {
  return segment(
    text
      .split(/\n\s*\n/)
      .map((t) => ({ kind: 'para' as const, text: t })),
    o,
  )
}
