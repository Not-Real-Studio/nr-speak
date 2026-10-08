/**
 * HTML → markdown для L0: Defuddle (`defuddle/node`) вырезает основной текст страницы
 * (без меню, рекламы, комментариев) и отдаёт markdown; DOM — linkedom.
 */

import { parseHTML } from 'linkedom'
import type { L0Opts, L0Result } from '../normalize.js'
import { l0Markdown, l0Text } from '../normalize.js'

export async function htmlToMarkdown(html: string, url?: string): Promise<{ title: string; markdown: string }> {
  const { Defuddle } = await import('defuddle/node')
  const { document } = parseHTML(html)
  const r = await Defuddle(document as unknown as Document, url, { markdown: true })
  const markdown = String(r.content ?? '').trim()
  if (!markdown) throw new Error(`speak: Defuddle не нашёл текста на странице${url ? ` ${url}` : ''}`)
  return { title: String(r.title ?? '').trim(), markdown }
}

export type InputFormat = 'text' | 'markdown' | 'html'

/** Формат по имени файла или адресу: `.html`/`.htm`/`http…` — html, `.txt` — text, иначе markdown. */
export function formatOf(name: string): InputFormat {
  if (/^https?:\/\//i.test(name) || /\.x?html?$/i.test(name)) return 'html'
  if (/\.txt$/i.test(name)) return 'text'
  return 'markdown'
}

/** Любой вход → блоки L0 (+ заголовок: у html — из страницы). */
export async function normalize(src: string, format: InputFormat, o: L0Opts & { url?: string | undefined } = {}): Promise<L0Result> {
  if (format === 'text') return l0Text(src, o)
  if (format === 'markdown') return l0Markdown(src, o)
  const { title, markdown } = await htmlToMarkdown(src, o.url)
  const r = l0Markdown(markdown, o)
  return { title: title || r.title, blocks: r.blocks }
}
