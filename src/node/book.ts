/**
 * Книги → markdown (DEV-250, speak-v2-spec §3): fb2 (+ fb2.zip), epub, pdf (текстовый слой),
 * docx. Дальше — обычный путь L0/профили; главы — заголовки markdown (`#` книга, `##`… главы
 * по вложенности), по ним читалка строит оглавление.
 *
 *   fb2   — свой разбор XML (linkedom): `title-info` → заголовок/автор, `section/title` →
 *           заголовки по вложенности, `p`, `emphasis`, `strong`, `poem/stanza/v` → строки,
 *           `epigraph`/`cite` → цитата, `subtitle`; `binary` и сноски (`body name="notes"`) — прочь.
 *           Кодировка — из XML-декларации (utf-8, windows-1251).
 *   epub  — zip (fflate) → container.xml → OPF: метаданные, spine (без `linear="no"`), заголовки
 *           глав из nav/NCX → xhtml глав → turndown → markdown.
 *   pdf   — `pdftotext -layout` (poppler): страницы по `\f`, колонтитулы и номера страниц
 *           (повторы сверху/снизу) — прочь, абзацы — по отступу и пустой строке, переносы
 *           (`‐`, мягкий, `-` перед строчной) — склеить. Нет текстового слоя — честная ошибка.
 *   docx  — mammoth → html → turndown.
 *
 * Формат — по сигнатуре (`%PDF`, zip: `mimetype` epub / `word/document.xml` / `*.fb2`,
 * `<FictionBook`), иначе по расширению.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, posix } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { DOMParser, parseHTML } from 'linkedom'

export const BOOK_FORMATS = ['fb2', 'fb2.zip', 'epub', 'pdf', 'docx'] as const
export type BookFormat = (typeof BOOK_FORMATS)[number]

export interface Book {
  format: BookFormat
  title: string
  author?: string | undefined
  /** Книга markdown'ом: `# Заголовок`, главы — `##`…`######` по вложенности. */
  markdown: string
}

export interface BookOpts {
  /** Сноски fb2 — в конец главой «Примечания» (по умолчанию — прочь). */
  notes?: boolean | undefined
  /** Путь к pdftotext (по умолчанию PATH + Homebrew). */
  pdftotext?: string | undefined
}

/** Потолок файла книги (спека: до 50 МБ). */
export const BOOK_MAX_BYTES = 50 * 1024 * 1024

const head = (data: Uint8Array, n: number): string => String.fromCharCode(...data.subarray(0, n))

const zipNames = (data: Uint8Array): string[] => {
  const names: string[] = []
  try {
    unzipSync(data, {
      filter: (f) => {
        names.push(f.name)
        return false
      },
    })
  } catch {
    return []
  }
  return names
}

/** Формат книги по сигнатуре (и расширению для подсказки); не книга — undefined. */
export function sniffBook(data: Uint8Array, name = ''): BookFormat | undefined {
  if (head(data, 5) === '%PDF-') return 'pdf'
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    const names = zipNames(data)
    if (names.includes('META-INF/container.xml') || names.includes('mimetype') && /epub/i.test(name)) return 'epub'
    if (names.includes('word/document.xml')) return 'docx'
    if (names.some((n) => /\.fb2$/i.test(n))) return 'fb2.zip'
    return undefined
  }
  const start = new TextDecoder('latin1').decode(data.subarray(0, 4096))
  if (/<FictionBook[\s>]/.test(start)) return 'fb2'
  if (/\.fb2$/i.test(name)) return 'fb2'
  return undefined
}

/** Книга → markdown по формату (`sniffBook`). */
export async function bookToMarkdown(data: Uint8Array, name = '', o: BookOpts = {}): Promise<Book> {
  if (data.length > BOOK_MAX_BYTES) throw new Error(`speak: файл больше ${BOOK_MAX_BYTES / 1024 / 1024} МБ`)
  const format = sniffBook(data, name)
  const book = await convert(format)
  return { ...book, markdown: tidyBook(book.markdown) }

  async function convert(format: BookFormat | undefined): Promise<Book> {
  switch (format) {
    case 'fb2':
      return fb2ToMarkdown(data, o)
    case 'fb2.zip': {
      const files = unzipSync(data, { filter: (f) => /\.fb2$/i.test(f.name) })
      const first = Object.values(files)[0]
      if (!first) throw new Error('speak: в архиве нет .fb2')
      return { ...fb2ToMarkdown(first, o), format: 'fb2.zip' }
    }
    case 'epub':
      return epubToMarkdown(data)
    case 'docx':
      return docxToMarkdown(data)
    case 'pdf':
      return pdfToMarkdown(data, o)
    default:
      throw new Error(`speak: не книга (${name || 'файл'}): есть fb2, fb2.zip, epub, pdf, docx`)
  }
  }
}

// --- общее ---

/** Текст для markdown: служебные символы — экранировать, чтобы remark не принял их за разметку. */
export function mdEscape(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/^(\s*)([#>+-]|\d+[.)])(?=\s)/, '$1\\$2')
    .trim()
}

/** «Глава II», «Часть 1», «Chapter 3», «IV». */
const CHAPTER = /^(?:(?:глава|часть|книга|chapter|part)\s+\S{1,12}|[IVXLC]{1,6})\.?$/iu

const heading = (level: number, text: string): string => `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${text}`

const join2 = (parts: readonly string[]): string =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n')

/**
 * Общая чистка книги для слуха: обвязка Project Gutenberg, разделы «Примечания», списки-оглавления
 * из ссылок на файлы книги; «Глава I» + заголовок той же глубины сразу за ним — одним заголовком.
 */
export function tidyBook(md: string): string {
  let s = md
  const start = /^.*\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*$/im.exec(s)
  if (start) {
    // Шапку (до START) — прочь, но заголовок книги и автора (первые строки) оставить.
    const top = s.slice(0, start.index).split('\n\n').slice(0, 2).join('\n\n')
    s = `${top}\n\n${s.slice(start.index + start[0].length)}`
  }
  const end = /^.*\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG[\s\S]*$/im.exec(s)
  if (end) s = s.slice(0, end.index)
  const lines = s.split('\n')
  const out: string[] = []
  let skipLevel = 0
  for (const line of lines) {
    const h = /^(#{1,6}) (.+)$/.exec(line)
    if (h) {
      const lvl = h[1]!.length
      skipLevel = 0
      if (/^(?:примечания|сноски|notes|footnotes|комментарии)\.?$/iu.test(h[2]!.trim())) {
        skipLevel = lvl
        continue
      }
      if (/project gutenberg/i.test(h[2]!)) {
        skipLevel = lvl
        continue
      }
    }
    if (skipLevel) continue
    // Оглавление ссылками на файлы самой книги.
    if (/^\s*(?:[-*+]|\d+\.)\s+\[[^\]]*\]\([^)\s]*\.x?html?(?:#[^)\s]*)?(?:\s+"[^"]*")?\)\s*$/i.test(line)) continue
    out.push(line)
  }
  // Глава абзацем (`I`, `Глава II` отдельной строкой между пустыми) — заголовок уровнем ниже последнего.
  let last = 1
  for (let i = 0; i < out.length; i++) {
    const h = /^(#{1,6}) /.exec(out[i]!)
    if (h) last = h[1]!.length
    else if (CHAPTER.test(out[i]!.trim()) && !out[i - 1]?.trim() && !out[i + 1]?.trim()) out[i] = heading(last === 1 ? 2 : last, out[i]!.trim().replace(/\.$/, ''))
  }
  // «## ГЛАВА I» + «## СЕРЖАНТ ГВАРДИИ» подряд → «## ГЛАВА I. СЕРЖАНТ ГВАРДИИ».
  return out
    .join('\n')
    .replace(/^(#{1,6}) ((?:глава|часть|chapter|part)\s+\S{1,12}|[IVXLC]{1,6})\.?\n+\1 (?!(?:глава|часть|chapter|part)\s)(.+)$/gimu, '$1 $2. $3')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- fb2 ---

/** Кодировка из XML-декларации (`encoding="windows-1251"`); нет — utf-8. */
export function xmlEncoding(data: Uint8Array): string {
  const decl = new TextDecoder('latin1').decode(data.subarray(0, 200))
  return /encoding=["']([\w-]+)["']/i.exec(decl)?.[1]?.toLowerCase() ?? 'utf-8'
}

type El = Element

const local = (e: Node): string => ((e as El).localName ?? (e as El).tagName ?? '').replace(/^.*:/, '').toLowerCase()
const kids = (e: El): El[] => Array.from(e.childNodes).filter((n) => n.nodeType === 1) as El[]
const kid = (e: El, name: string): El | undefined => kids(e).find((k) => local(k) === name)

/** Инлайн fb2 → markdown: emphasis/strong — разметкой, ссылки-сноски — прочь. */
function fb2Inline(e: Node): string {
  if (e.nodeType === 3) return (e.textContent ?? '').replace(/([\\`*_[\]<>|])/g, '\\$1')
  if (e.nodeType !== 1) return ''
  const name = local(e)
  const inner = Array.from(e.childNodes).map(fb2Inline).join('')
  switch (name) {
    case 'emphasis':
      return inner.trim() ? `*${inner.trim()}*` : inner
    case 'strong':
      return inner.trim() ? `**${inner.trim()}**` : inner
    case 'a':
      return (e as El).getAttribute('type') === 'note' || /^\[?\d+\]?$/.test(inner.trim()) ? '' : inner
    case 'image':
      return ''
    default:
      return inner
  }
}

const para = (e: El): string => {
  const t = Array.from(e.childNodes).map(fb2Inline).join('').replace(/\s+/g, ' ').trim()
  return t.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s)/, '$1\\$2')
}

const titleText = (t: El | undefined): string =>
  t
    ? kids(t)
        .filter((k) => local(k) === 'p')
        .map((p) => para(p).replace(/^\*+|\*+$/g, '').replace(/[.:]$/, '').trim())
        .filter(Boolean)
        .join('. ')
    : ''

function poem(e: El): string[] {
  const out: string[] = []
  for (const k of kids(e)) {
    const n = local(k)
    if (n === 'title') {
      const t = titleText(k)
      if (t) out.push(`**${t}**`)
    } else if (n === 'stanza') {
      const lines = kids(k)
        .filter((v) => local(v) === 'v')
        .map(para)
        .filter(Boolean)
      if (lines.length) out.push(lines.join('  \n'))
    } else if (n === 'text-author' || n === 'date') {
      const t = para(k)
      if (t) out.push(t)
    }
  }
  return out
}

/** Блоки секции/тела fb2 → абзацы markdown; вложенные секции — заголовками уровнем ниже. */
function fb2Blocks(e: El, level: number): string[] {
  const out: string[] = []
  // Секция сама — «Глава I», а дальше главы абзацами — они ей ровня, не вложенные.
  const own = titleText(kid(e, 'title'))
  const chapterLevel = CHAPTER.test(own) ? level : level + 1
  for (const k of kids(e)) {
    switch (local(k)) {
      case 'title': {
        const t = titleText(k)
        // Длинный «заголовок» — на деле абзац (комментарии издания): читается абзацем.
        if (t) out.push(t.length > 150 ? t : heading(level, t))
        break
      }
      case 'section':
        out.push(...fb2Blocks(k, level + 1))
        break
      case 'p': {
        const t = para(k)
        // Главы абзацем (`<p><strong>Глава II</strong></p>`, az.lib.ru) — заголовок уровнем ниже секции.
        const ch = /^\*{1,3}([^*]{1,50})\*{1,3}$/u.exec(t)
        if (ch && CHAPTER.test(ch[1]!)) out.push(heading(chapterLevel, ch[1]!.replace(/\.$/, '')))
        else if (t) out.push(t)
        break
      }
      case 'subtitle': {
        const t = para(k)
        if (t && /[\p{L}\p{N}]/u.test(t)) out.push(`**${t}**`)
        break
      }
      case 'poem':
        out.push(...poem(k))
        break
      case 'epigraph':
      case 'cite': {
        const inner = kids(k).flatMap((c) => (local(c) === 'poem' ? poem(c) : local(c) === 'p' || local(c) === 'text-author' || local(c) === 'subtitle' ? [para(c)] : local(c) === 'stanza' ? poem(k) : []))
        const t = inner.filter(Boolean)
        if (t.length) out.push(t.map((x) => x.split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n'))
        break
      }
      case 'table': {
        const rows = kids(k)
          .filter((r) => local(r) === 'tr')
          .map((r) => kids(r).map((c) => para(c).replace(/\|/g, '\\|')))
        if (rows.length) {
          const cols = Math.max(...rows.map((r) => r.length))
          const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ')} |`
          out.push([line(rows[0]!), `|${' --- |'.repeat(cols)}`, ...rows.slice(1).map(line)].join('\n'))
        }
        break
      }
      default:
        // image, empty-line, annotation, binary — не для слуха
        break
    }
  }
  return out
}

/** fb2 (байты, кодировка из декларации) → markdown. */
export function fb2ToMarkdown(data: Uint8Array, o: BookOpts = {}): Book {
  const enc = xmlEncoding(data)
  let text: string
  try {
    text = new TextDecoder(enc).decode(data)
  } catch {
    throw new Error(`speak: fb2 в кодировке ${enc} — не умею (есть utf-8, windows-1251)`)
  }
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, '').replace(/<binary[\s\S]*?<\/binary>/g, ''), 'text/xml') as unknown as Document
  const root = Array.from(doc.querySelectorAll('*')).find((e) => local(e) === 'fictionbook')
  if (!root) throw new Error('speak: это не fb2 (нет FictionBook)')
  const info = Array.from(root.querySelectorAll('*')).find((e) => local(e) === 'title-info')
  const bookTitle = info ? para(kid(info, 'book-title') ?? info).trim() : ''
  const authorEl = info ? kid(info, 'author') : undefined
  const author = authorEl
    ? ['first-name', 'middle-name', 'last-name']
        .map((n) => kid(authorEl, n)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ') || kid(authorEl, 'nickname')?.textContent?.trim()
    : undefined
  const bodies = kids(root).filter((k) => local(k) === 'body')
  const main = bodies.filter((b) => !b.getAttribute('name') || b.getAttribute('name') === 'main')
  const notes = bodies.filter((b) => b.getAttribute('name') === 'notes')
  const parts: string[] = []
  const title = bookTitle || 'Без названия'
  parts.push(heading(1, mdEscape(title)))
  if (author) parts.push(`${mdEscape(author)}.`)
  for (const b of main) {
    // Заголовок тела часто повторяет автора и название — он уже сверху.
    const blocks = fb2Blocks(b, 1).filter((x, i) => !(i === 0 && x.startsWith('# ')))
    parts.push(...blocks)
  }
  if (o.notes)
    for (const b of notes) {
      const blocks = fb2Blocks(b, 2).filter((x) => !/^#{2,} \d+$/.test(x))
      if (blocks.length) parts.push(heading(2, 'Примечания'), ...blocks.filter((x) => !/^## Примечания$/.test(x)))
    }
  return { format: 'fb2', title, ...(author ? { author } : {}), markdown: join2(parts) }
}

// --- html → markdown (epub, docx) ---

const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i

type Td = { turndown(n: unknown): string }

let tdCache: Td | undefined

async function turndown(): Promise<Td> {
  if (tdCache) return tdCache
  const { default: TurndownService } = await import('turndown')
  const td = new TurndownService({ headingStyle: 'atx', emDelimiter: '*', bulletListMarker: '-', codeBlockStyle: 'fenced' })
  td.remove(['style', 'script', 'head', 'title', 'img', 'svg', 'nav'] as never)
  // Wikisource: заголовки — `<div role="heading" aria-level="3">`.
  td.addRule('aria-heading', {
    filter: (n) => (n as HTMLElement).getAttribute?.('role') === 'heading',
    replacement: (c, n) => `\n\n${'#'.repeat(Math.min(6, Number((n as HTMLElement).getAttribute('aria-level')) || 2))} ${c.replace(/\s+/g, ' ').trim()}\n\n`,
  })
  // Ссылки-сноски (`<a href="#n1"><sup>1</sup></a>`, `<sup>`) — прочь.
  td.addRule('noteref', {
    filter: (n) => n.nodeName === 'SUP' || (n.nodeName === 'A' && /^#/.test((n as HTMLElement).getAttribute('href') ?? '') && /^\[?\d+\]?$/.test((n.textContent ?? '').trim())),
    replacement: () => '',
  })
  tdCache = td
  return td
}

/** html/xhtml главы → markdown (самозакрытые не-void теги XHTML раскрываются до разбора). */
export async function htmlToMd(html: string): Promise<string> {
  const fixed = html.replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\/>/g, (m, tag: string, attrs = '') => (VOID.test(tag) ? m : `<${tag}${attrs}></${tag}>`))
  const clean = fixed.replace(/<\?xml[^>]*>/, '').replace(/<!DOCTYPE[^>]*>/i, '')
  // linkedom без `<html>` не строит body.
  const { document } = parseHTML(/<html[\s>]/i.test(clean) ? clean : `<html><body>${clean}</body></html>`)
  const body = document.body ?? document.documentElement
  return (await turndown())
    .turndown(body)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- epub ---

const xmlDoc = (s: string): Document => new DOMParser().parseFromString(s, 'text/xml') as unknown as Document
const byLocal = (root: Document | El, name: string): El[] => Array.from(root.querySelectorAll('*')).filter((e) => local(e) === name)

/** Служебные главы: лицензия Gutenberg, «Информация»/«Заглавие» ws-export, обложка, оглавление. */
const SERVICE = /(?:^|\/)(?:pg-(?:header|footer)|.*license.*|about|title|cover|toc|nav|titlepage|wrap0000)\.x?html?$/i

/** epub (zip) → markdown: главы по spine, заголовок главы — из nav/NCX, если в тексте его нет. */
export async function epubToMarkdown(data: Uint8Array): Promise<Book> {
  let zip: Record<string, Uint8Array>
  try {
    zip = unzipSync(data, { filter: (f) => !/\.(ttf|otf|woff2?|png|jpe?g|gif|svg|webp|mp3|mp4)$/i.test(f.name) })
  } catch (err) {
    throw new Error(`speak: epub не распаковался: ${(err as Error).message}`)
  }
  const read = (p: string): string | undefined => {
    const u = zip[p] ?? zip[decodeURIComponent(p)]
    return u ? strFromU8(u) : undefined
  }
  const container = read('META-INF/container.xml')
  if (!container) throw new Error('speak: epub без META-INF/container.xml')
  const opfPath = byLocal(xmlDoc(container), 'rootfile')[0]?.getAttribute('full-path')
  const opfText = opfPath ? read(opfPath) : undefined
  if (!opfPath || !opfText) throw new Error('speak: epub без OPF')
  const base = posix.dirname(opfPath)
  const abs = (dir: string, h: string): string => posix.normalize(posix.join(dir, decodeURIComponent(h.split('#')[0] ?? '')))
  const opf = xmlDoc(opfText)
  const meta = (n: string): string[] =>
    byLocal(opf, n)
      .map((e) => (e.textContent ?? '').trim())
      .filter(Boolean)
  const manifest = new Map(byLocal(opf, 'item').map((i) => [i.getAttribute('id') ?? '', { href: abs(base, i.getAttribute('href') ?? ''), type: i.getAttribute('media-type') ?? '', props: i.getAttribute('properties') ?? '' }]))
  const spine = byLocal(opf, 'itemref')
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => manifest.get(r.getAttribute('idref') ?? ''))
    .filter((x): x is { href: string; type: string; props: string } => !!x && /x?html/.test(x.type))
  // Заголовки глав: EPUB3 nav, иначе NCX.
  const titles = new Map<string, string>()
  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'))
  const navText = nav ? read(nav.href) : undefined
  if (nav && navText) {
    const { document } = parseHTML(navText)
    for (const a of Array.from(document.querySelectorAll('nav a[href]'))) {
      const f = abs(posix.dirname(nav.href), a.getAttribute('href') ?? '')
      if (!titles.has(f)) titles.set(f, (a.textContent ?? '').replace(/\s+/g, ' ').trim())
    }
  } else {
    const ncx = manifest.get(byLocal(opf, 'spine')[0]?.getAttribute('toc') ?? '')
    const ncxText = ncx ? read(ncx.href) : undefined
    if (ncx && ncxText)
      for (const np of byLocal(xmlDoc(ncxText), 'navpoint')) {
        const label = (byLocal(np, 'text')[0]?.textContent ?? '').replace(/\s+/g, ' ').trim()
        const src = byLocal(np, 'content')[0]?.getAttribute('src')
        if (src && label) {
          const f = abs(posix.dirname(ncx.href), src)
          if (!titles.has(f)) titles.set(f, label)
        }
      }
  }
  const title = meta('title')[0] ?? 'Без названия'
  const author = meta('creator')
    .map((a) => a.replace(/^автор\s+/i, ''))
    .join(', ')
  const parts = [heading(1, mdEscape(title)), ...(author ? [`${mdEscape(author)}.`] : [])]
  for (const item of spine) {
    if (SERVICE.test(item.href)) continue
    const html = read(item.href)
    if (!html) continue
    // Заголовки главы — от `##` (книга — `#`).
    let md = (await htmlToMd(html)).replace(/^(#{1,5}) /gm, '#$1 ')
    if (!md.replace(/\s+/g, '')) continue
    const t = titles.get(item.href)
    if (t && !/^#{1,6} /.test(md.trimStart())) md = `${heading(2, mdEscape(t))}\n\n${md}`
    parts.push(md)
  }
  if (parts.length <= 2) throw new Error('speak: в epub не нашлось текста глав')
  return { format: 'epub', title, ...(author ? { author } : {}), markdown: join2(parts) }
}

// --- docx ---

/** docx → markdown: mammoth → html → turndown; без стилей — короткий жирный абзац = заголовок. */
export async function docxToMarkdown(data: Uint8Array): Promise<Book> {
  const mammoth = (await import('mammoth')).default as unknown as {
    convertToHtml(input: { buffer: Buffer }, o?: Record<string, unknown>): Promise<{ value: string }>
    images: { imgElement(f: () => Promise<{ src: string }>): unknown }
  }
  const { value } = await mammoth.convertToHtml(
    { buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength) },
    { styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"], convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
  )
  const styled = /<h[1-6][\s>]/.test(value)
  const html = value
    // Без стилей (нет ни одного h1–h6): абзац целиком жирный и короткий — заголовок главы.
    .replace(/<p><strong>([^<]{1,80})<\/strong><\/p>/g, (m, t: string) => (styled ? m : `<h2>${t}</h2>`))
    // Псевдо-списки «•\tпункт».
    .replace(/<p>\s*[•·▪–]\s+([\s\S]*?)<\/p>/g, '<ul><li>$1</li></ul>')
  let md = await htmlToMd(`<html><body>${html}</body></html>`)
  const first = /^#{1,6} (.+)$/m.exec(md)?.[1]?.trim()
  const title = first ?? md.split('\n').find((l) => l.trim())?.slice(0, 80) ?? 'Без названия'
  if (!/^# /m.test(md)) md = md.replace(/^## /m, '# ')
  return { format: 'docx', title, markdown: md }
}

// --- pdf ---

const BREW = ['/opt/homebrew/bin', '/usr/local/bin']

function run(bin: string, args: string[]): Promise<string> {
  const PATH = [process.env.PATH ?? '', ...BREW].filter(Boolean).join(delimiter)
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env: { ...process.env, PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    p.stdout.on('data', (b: Buffer) => out.push(b))
    p.stderr.on('data', (b: Buffer) => err.push(b))
    p.on('error', (e) => reject(new Error(`speak: ${bin} не запустился (нужен poppler: brew install poppler): ${e.message}`)))
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`speak: ${bin} вышел с кодом ${code}: ${Buffer.concat(err).toString().trim().slice(0, 300)}`))))
  })
}

export const NO_TEXT_LAYER = 'speak: в PDF нет текстового слоя (скан) — OCR не поддерживается'

/** Номер страницы / колонтитул: цифры → `#`, пробелы схлопнуть. */
const lineKey = (l: string): string => l.trim().replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase()
const PAGE_NO = /^\s*(?:[—–-]\s*)?(?:стр\.?\s*)?\d{1,4}(?:\s*[—–-])?\s*$|^\s*\d{1,4}\s*(?:из|\/)\s*\d{1,4}\s*$/i
const HYPHEN_END = /([\p{L}])[‐­-]$/u

/**
 * Текст `pdftotext -layout` → markdown: колонтитулы (строки сверху/снизу, повторяющиеся на
 * многих страницах) и номера страниц — прочь; абзац — по отступу и пустой строке; переносы —
 * склеить. Чистая функция (тестируется без poppler).
 */
export function pdfLayoutToMarkdown(text: string, title = ''): string {
  const pages = text.replace(/\r\n?/g, '\n').split('\f').map((p) => p.split('\n'))
  const edges = (lines: string[]): string[] => {
    const nonEmpty = lines.map((l, i) => [l, i] as const).filter(([l]) => l.trim())
    return [...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)].map(([l]) => lineKey(l))
  }
  const counts = new Map<string, number>()
  for (const p of pages) for (const k of new Set(edges(p))) counts.set(k, (counts.get(k) ?? 0) + 1)
  const textPages = pages.filter((p) => p.some((l) => l.trim())).length
  const repeated = (k: string): boolean => textPages >= 3 && (counts.get(k) ?? 0) >= Math.max(3, Math.ceil(textPages * 0.3))
  // Поле — по всем страницам (на странице из одного абзаца своё поле съело бы отступ).
  const allIndents = pages.flatMap((p) => p.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
  const margin = allIndents.length ? Math.min(...allIndents) : 0
  const paras: string[] = []
  let cur = ''
  const flush = (): void => {
    const t = cur.replace(/\s+/g, ' ').trim()
    if (t) paras.push(t)
    cur = ''
  }
  for (const page of pages) {
    const nonEmpty = page.map((l, i) => [l, i] as const).filter(([l]) => l.trim())
    const edgeIdx = new Set([...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)].map(([, i]) => i))
    const kept = page.filter((l, i) => !(edgeIdx.has(i) && (PAGE_NO.test(l) || repeated(lineKey(l)))))
    // Пустые строки по краям страницы — не граница абзаца (абзац и перенос идут через страницу).
    let a = 0
    let b = kept.length
    while (a < b && !kept[a]!.trim()) a++
    while (b > a && !kept[b - 1]!.trim()) b--
    const body = kept.slice(a, b)
    for (const raw of body) {
      if (!raw.trim()) {
        flush()
        continue
      }
      const indent = raw.length - raw.trimStart().length - margin
      const line = raw.trim().replace(/\s{2,}/g, ' ')
      const isHeading = line.length <= 60 && CHAPTER.test(line)
      if (isHeading) {
        flush()
        paras.push(`## ${line.replace(/\.$/, '')}`)
        continue
      }
      if (indent >= 2 && cur) flush()
      if (!cur) cur = line
      else if (HYPHEN_END.test(cur) && /^[\p{Ll}]/u.test(line)) cur = cur.slice(0, -1) + line
      else cur += ` ${line}`
    }
  }
  flush()
  const body = paras.map((p) => (p.startsWith('## ') ? p : mdEscape(p)))
  return join2([...(title ? [heading(1, mdEscape(title))] : []), ...body])
}

/** pdf → markdown через `pdftotext -layout`; нет текстового слоя — ошибка `NO_TEXT_LAYER`. */
export async function pdfToMarkdown(data: Uint8Array, o: BookOpts = {}): Promise<Book> {
  const dir = await mkdtemp(join(tmpdir(), 'speak-pdf-'))
  try {
    const file = join(dir, 'in.pdf')
    await writeFile(file, data)
    const bin = o.pdftotext ?? 'pdftotext'
    const [text, info] = await Promise.all([run(bin, ['-layout', '-enc', 'UTF-8', file, '-']), run(bin.replace(/pdftotext$/, 'pdfinfo'), ['-enc', 'UTF-8', file]).catch(() => '')])
    const pages = Math.max(1, Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? text.split('\f').length))
    const letters = text.replace(/[\s\f]/g, '').length
    if (letters < 20 * pages) throw new Error(NO_TEXT_LAYER)
    const metaTitle = /^Title:\s+(.+)$/m.exec(info)?.[1]?.trim()
    const markdown = pdfLayoutToMarkdown(text, metaTitle && !/^untitled|^microsoft word/i.test(metaTitle) ? metaTitle : '')
    const title = metaTitle || /^#{1,6} (.+)$/m.exec(markdown)?.[1] || markdown.split('\n')[0]?.slice(0, 80) || 'PDF'
    return { format: 'pdf', title, markdown }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
