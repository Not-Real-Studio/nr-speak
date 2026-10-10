/**
 * Нормализатор L0 — детерминированный фильтр «текст для глаз → текст для слуха».
 * Вход — markdown (или простой текст; html → markdown делает `htmlToMarkdown` из
 * `@notrealstudio/speak/node`). Markdown → mdast (remark + gfm + frontmatter), обход:
 *
 * - выкидывается: frontmatter, картинки, адреса ссылок (текст ссылки остаётся), голые
 *   URL, сноски, HTML и комментарии; мусор-токены (`stripTokens`) — hex от 7 символов с
 *   цифрой и буквой (хэши, ключи любой длины), UUID, base64-подобные строки, ключи и токены
 *   по префиксам (`sk-`, `ghp_`, `AIza`, JWT `eyJ…`, `Bearer …`), секреты в параметрах
 *   адреса (`?key=…`); «ключ: <токен>» → «ключ»;
 * - блок кода — фраза «Пропущен блок кода.» (`code: 'announce'`) или ничего (`skip`);
 * - инлайн-код: короткое слово/идентификатор — текстом без бэктиков; путь, флаг, длинное —
 *   по политике `inlineCode`: `read` (текстом, разделители `/ _ =` → пробел), `announce`
 *   («код»), `skip`;
 * - таблицы (gfm и box-drawing `┌│├┼─`): до 4 колонок и 8 строк — построчно
 *   «<заголовок строки>: <колонка> — <значение>; …», больше — «Таблица, N строк,
 *   колонки: …» (`tables: rows|announce|skip`);
 * - заголовок — отдельный блок (сегментатор даёт ему свой кусок), пункт списка —
 *   предложение.
 *
 * Числа не трогаются (это L1). Выход — блоки `{kind, text}` → `segment()`.
 */

import type { Heading, List, ListItem, Nodes, Parent, Root, Table } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Block } from './segment.js'
import { closeSentence, sentences } from './segment.js'

export interface L0Opts {
  /** Блок кода: `announce` (по умолчанию) — «Пропущен блок кода.», `skip` — ничего. */
  code?: 'announce' | 'skip' | undefined
  /** Инлайн-код, не похожий на слово (путь, флаг, длинное): `read` (по умолчанию), `announce`, `skip`. */
  inlineCode?: 'read' | 'announce' | 'skip' | undefined
  /** Таблицы: `rows` (по умолчанию) — построчно, если влезают; `announce` — только объявить; `skip`. */
  tables?: 'rows' | 'announce' | 'skip' | undefined
  /** Фраза для блока кода. */
  codePhrase?: string | undefined
}

export interface L0Result {
  /** Первый заголовок (или первая строка). */
  title: string
  blocks: Block[]
}

/** Порог «таблица читается построчно». */
export const TABLE_MAX_COLS = 4
export const TABLE_MAX_ROWS = 8

const CODE_PHRASE = 'Пропущен блок кода.'
const BOX = /[┌┬┐├┼┤└┴┘│─╔╦╗╠╬╣╚╩╝║═╭╮╯╰]/
const BOX_LINE = /^\s*[┌┬┐├┼┤└┴┘│─╔╦╗╠╬╣╚╩╝║═╭╮╯╰]/
const BOX_RULE = /^[\s┌┬┐├┼┤└┴┘─╔╦╗╠╬╣╚╩╝═╭╮╯╰+|:-]+$/

/** Хэш: от 7 hex-символов, хотя бы одна цифра и одна буква (иначе это число или слово). */
const HEX = String.raw`(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}`
const HASH_WHOLE = new RegExp(`^${HEX}$`, 'i')
const B = String.raw`(?<![\p{L}\p{N}_])`
const E = String.raw`(?![\p{L}\p{N}_])`
/**
 * Мусор-токены — то, что голосом читается посимвольно и смысла не несёт. Порядок важен:
 * сначала целые конструкции (`Bearer …`, префиксные ключи, JWT), потом общие формы.
 */
const TOKENS: readonly RegExp[] = [
  // `Bearer <токен>` — целиком, вместе со словом.
  /\bBearer\s+[A-Za-z0-9._~+/=…*-]{5,}[A-Za-z0-9_=…*]/gu,
  // Ключи по префиксам: OpenAI/Stripe `sk-`/`sk_`/`pk_`/`rk_`, GitHub `ghp_`/`gho_`/`ghs_`/`ghu_`/`github_pat_`,
  // Slack `xoxb-`/`xoxa-`/`xoxp-`, Google `AIza…`, OAuth `ya29.…`; хвост — с маской `…`/`*`.
  new RegExp(`${B}(?:sk|pk|rk)[-_](?:[a-z]+[-_])?[A-Za-z0-9…*][A-Za-z0-9_…*.-]{4,}[A-Za-z0-9_…*]${E}`, 'gu'),
  new RegExp(`${B}(?:gh[pousr]_|github_pat_)[A-Za-z0-9_…*]{6,}${E}`, 'gu'),
  new RegExp(`${B}xox[bapros]-[A-Za-z0-9…*-]{6,}${E}`, 'gu'),
  new RegExp(`${B}AIza[0-9A-Za-z_…*-]{10,}${E}`, 'gu'),
  new RegExp(`${B}ya29\\.[0-9A-Za-z_…*.-]{9,}[0-9A-Za-z_…*]${E}`, 'gu'),
  // JWT: `eyJ…` (заголовок base64url), с точками частей.
  new RegExp(`${B}eyJ[A-Za-z0-9_-]{8,}(?:\\.[A-Za-z0-9_-]*){0,2}${E}`, 'gu'),
  // Адрес без схемы с секретом в параметре (`host/tts?key=…&text=…`) — целиком.
  /[^\s()«»"'[\]]*[?&](?:key|api[_-]?key|token|access[_-]?token|secret|sig|signature|password|pwd|auth)=[^\s)\]»"']*[^\s)\]»"'.,;:!?]/giu,
  // UUID.
  new RegExp(`${B}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${E}`, 'giu'),
  // Сокращённый в середине hex-ключ: `84b871fc…77606`, `84b8...7760`.
  new RegExp(`${B}[0-9a-f]{4,}(?:…|\\.{3})[0-9a-f]{3,}${E}`, 'giu'),
  // hex от 7 символов без верхней границы (хэши коммитов, ключи API).
  new RegExp(`${B}${HEX}${E}`, 'giu'),
  // base64/base64url от 20 символов: оба регистра и цифра (`dGhpcyBpcyBh…`, `AbC9_xYz-…`).
  new RegExp(`${B}(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\\d)[A-Za-z0-9+/_-]{20,}={0,2}(?![\\p{L}\\p{N}_=])`, 'gu'),
  // Случайная строка в нижнем регистре от 24 символов с ≥4 цифрами и ≥4 буквами, без разделителей.
  new RegExp(`${B}(?=(?:[a-z]*\\d){4})(?=(?:\\d*[a-z]){4})[a-z0-9]{24,}${E}`, 'gu'),
]

/**
 * Мусор-токены → пусто; «ключ: <токен>» → «ключ» (двоеточие перед пустым местом уходит).
 * Числа (`1234567`), слова (`deadbeef`), идентификаторы с разделителями — не трогаются.
 */
export function stripTokens(s: string): string {
  let out = s
  for (const re of TOKENS) out = out.replace(re, '\u0000')
  if (out === s) return s
  return out
    .replace(/\s*[:=]\s*\u0000/gu, '')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?…»)])/g, '$1')
    .trim()
}

/** Сноски-номера и пометки вики (`[1]`, `[a]`, `[уточнить]`, `[источник не указан 123 дня]`). */
const NOTE = /\[(?:\d{1,3}|[a-zа-я]|уточнить|источник[^\]]{0,40}|нет в источнике|нет АИ[^\]]{0,20}|неавторитетный источник\??|когда\?|кем\?|где\?|что\?|прояснить|стиль|орфография)\]/giu
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()\]]+[^\s<>()\].,;:!?»"']/giu

/** Чистка строки для слуха: голые адреса, мусор-токены, сноски, пустые скобки, пробелы. */
export function cleanInline(s: string): string {
  return stripTokens(s.replace(URL_RE, ''))
    .replace(NOTE, '')
    .replace(/\s*:\s*(?=[.,;!?])/g, '')
    .replace(/\(\s*[,;]?\s*\)|\[\s*\]/g, '')
    .replace(/\s+[—–]\s*(?=[,.;:!?])/g, '')
    .replace(/\s+([,.;:!?…»)])/g, '$1')
    .replace(/([«(])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Короткое слово или идентификатор: читается как текст. */
const WORDISH = /^[\p{L}\p{N}][\p{L}\p{N}.'’+#-]*$/u

export function inlineCode(value: string, policy: L0Opts['inlineCode'] = 'read'): string {
  const v = value.trim()
  if (!v) return ''
  if (HASH_WHOLE.test(v) || !stripTokens(v).trim()) return ''
  if (v.length <= 24 && WORDISH.test(v)) return v
  if (policy === 'skip') return ''
  if (policy === 'announce') return 'код'
  return v
    .replace(/^\$|^-{1,2}/, '')
    .split(/[/\\]+/)
    .map((p) => p.replace(/^[~.]+/, '').replace(/[<>`]/g, ''))
    .filter(Boolean)
    .join(' ')
    .replace(/[_=|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const looksLikeUrl = (s: string): boolean => /^(?:https?:\/\/|www\.|mailto:)/i.test(s.trim())

function inline(node: Nodes, o: L0Opts): string {
  switch (node.type) {
    case 'text':
      return node.value
    case 'inlineCode':
      return inlineCode(node.value, o.inlineCode)
    case 'break':
      return ' '
    case 'image':
    case 'imageReference':
    case 'footnoteReference':
    case 'html':
    case 'definition':
    case 'footnoteDefinition':
      return ''
    case 'link': {
      const text = kids(node, o).trim()
      return !text || looksLikeUrl(text) || text === node.url ? '' : text
    }
    default:
      return 'children' in node ? kids(node as Parent, o) : 'value' in node ? String((node as { value: unknown }).value) : ''
  }
}

const kids = (node: Parent, o: L0Opts): string => node.children.map((c) => inline(c as Nodes, o)).join('')

const text = (node: Nodes, o: L0Opts): string => cleanInline(inline(node, o).replace(/\s+/g, ' '))

// --- таблицы ---

/** Таблица → фразы. `rows[0]` — заголовок. */
export function tableText(rows: string[][], mode: L0Opts['tables'] = 'rows'): string {
  if (mode === 'skip' || rows.length === 0) return ''
  const head = rows[0]!
  const body = rows.slice(1).filter((r) => r.some((c) => c.trim()))
  const cols = Math.max(head.length, ...body.map((r) => r.length))
  const named = head.map((c) => c.trim()).filter(Boolean)
  if (mode === 'announce' || cols > TABLE_MAX_COLS || body.length > TABLE_MAX_ROWS || body.length === 0) {
    const n = body.length
    const word = n % 10 === 1 && n % 100 !== 11 ? 'строка' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'строки' : 'строк'
    return `Таблица, ${n} ${word}${named.length ? `, колонки: ${named.join(', ')}` : ''}.`
  }
  return body
    .map((r) => {
      const cells = r.map((c) => c.trim())
      const first = cells[0] ?? ''
      const rest: string[] = []
      for (let i = 1; i < cols; i++) {
        const v = cells[i] ?? ''
        if (!v) continue
        const h = head[i]?.trim()
        rest.push(h ? `${h} — ${v}` : v)
      }
      if (cols === 1) return closeSentence(first)
      return closeSentence(first ? `${first}: ${rest.join('; ')}` : rest.join('; '))
    })
    .join(' ')
}

/** Box-drawing таблица (`┌─┬─┐ │ a │ b │ ├─┼─┤ …`) → строки ячеек. */
export function parseBoxTable(lines: readonly string[]): string[][] {
  const rows: string[][] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t || BOX_RULE.test(t)) continue
    const cells = t.replace(/^[│║|]/, '').replace(/[│║|]$/, '').split(/[│║]/)
    rows.push(cells.map((c) => cleanInline(c.replace(/\s+/g, ' '))))
  }
  return rows
}

// --- обход ---

function listBlocks(list: List, o: L0Opts, out: Block[]): void {
  const items: string[] = []
  const walkItem = (item: ListItem): void => {
    const own: string[] = []
    for (const c of item.children) {
      if (c.type === 'list') {
        if (own.length) items.push(closeSentence(own.join(' ')))
        own.length = 0
        for (const sub of c.children) walkItem(sub)
      } else if (c.type === 'code') {
        if (own.length) items.push(closeSentence(own.join(' ')))
        own.length = 0
        if (o.code !== 'skip') items.push(o.codePhrase ?? CODE_PHRASE)
      } else {
        const t = text(c as Nodes, o)
        if (t) own.push(t)
      }
    }
    if (own.length) items.push(closeSentence(own.join(' ')))
  }
  for (const item of list.children) walkItem(item)
  if (items.length) out.push({ kind: 'list', text: items.join(' ') })
}

function walk(nodes: readonly Nodes[], o: L0Opts, out: Block[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'yaml':
      case 'toml' as never:
      case 'html':
      case 'definition':
      case 'footnoteDefinition':
      case 'thematicBreak':
        break
      case 'heading': {
        const t = text(node as Heading, o)
        if (t) out.push({ kind: 'heading', text: t })
        break
      }
      case 'code':
        if (o.code !== 'skip') out.push({ kind: 'code', text: o.codePhrase ?? CODE_PHRASE })
        break
      case 'list':
        listBlocks(node, o, out)
        break
      case 'blockquote': {
        const inner: Block[] = []
        walk(node.children as Nodes[], o, inner)
        for (const b of inner) out.push(b.kind === 'para' ? { kind: 'quote', text: b.text } : b)
        break
      }
      case 'table': {
        const rows = (node as Table).children.map((r) => r.children.map((c) => text(c as Nodes, o)))
        const t = tableText(rows, o.tables)
        if (t) out.push({ kind: 'table', text: t })
        break
      }
      case 'paragraph': {
        const t = text(node, o)
        if (t) out.push({ kind: 'para', text: t })
        break
      }
      default:
        if ('children' in node) walk((node as Parent).children as Nodes[], o, out)
    }
  }
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml'])

/** Markdown → блоки. Box-drawing таблицы вырезаются до разбора (markdown их не знает). */
export function l0Markdown(md: string, o: L0Opts = {}): L0Result {
  const blocks: Block[] = []
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  let chunk: string[] = []
  const flushMd = (): void => {
    if (chunk.join('').trim()) walk((parser.parse(chunk.join('\n')) as Root).children as Nodes[], o, blocks)
    chunk = []
  }
  for (let i = 0; i < lines.length; ) {
    // Таблица box-drawing: подряд строки, начинающиеся с рамки, и в них есть `│`.
    if (BOX_LINE.test(lines[i]!)) {
      let j = i
      while (j < lines.length && BOX_LINE.test(lines[j]!)) j++
      const region = lines.slice(i, j)
      if (region.some((l) => /[│║]/.test(l)) && region.length >= 2) {
        flushMd()
        const t = tableText(parseBoxTable(region), o.tables)
        if (t) blocks.push({ kind: 'table', text: t })
        i = j
        continue
      }
    }
    chunk.push(lines[i]!)
    i++
  }
  flushMd()
  return { title: titleOf(blocks), blocks }
}

/** Простой текст: абзацы по пустой строке, box-таблицы, чистка строк — без разбора markdown. */
export function l0Text(src: string, o: L0Opts = {}): L0Result {
  const blocks: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  const flush = (): void => {
    const t = cleanInline(para.join(' ').replace(/\s+/g, ' '))
    if (t) blocks.push({ kind: 'para', text: t })
    para = []
  }
  for (let i = 0; i < lines.length; ) {
    if (BOX_LINE.test(lines[i]!)) {
      let j = i
      while (j < lines.length && BOX_LINE.test(lines[j]!)) j++
      flush()
      const t = tableText(parseBoxTable(lines.slice(i, j)), o.tables)
      if (t) blocks.push({ kind: 'table', text: t })
      i = j
      continue
    }
    if (!lines[i]!.trim()) flush()
    else para.push(lines[i]!)
    i++
  }
  flush()
  return { title: titleOf(blocks), blocks }
}

/** Заголовок: первый блок-заголовок, если текст с него начинается, иначе первое предложение. */
export function titleOf(blocks: readonly Block[]): string {
  const first = blocks[0]
  if (!first) return ''
  const t = first.kind === 'heading' ? first.text : (sentences(first.text)[0] ?? first.text)
  return t.length > 120 ? `${t.slice(0, 119)}…` : t
}

/** Блоки → текст для чтения глазами (`--print`): абзац на блок, заголовок — с `#`. */
export function blocksText(blocks: readonly Block[]): string {
  return blocks.map((b) => (b.kind === 'heading' ? `# ${b.text}` : b.text)).join('\n\n')
}
